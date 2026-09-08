'use strict';

/**
 * Can this process still read a directory it has removed its own permission
 * from?
 *
 * Several tests stage a genuine `EACCES` with `chmod 000` — the only way to
 * exercise "there, and refused" rather than "not there", which is the whole
 * distinction the uploads and project-facts reads exist to draw. Root defeats
 * the mode bits, so under root those fixtures do not fail, they pass for the
 * wrong reason: the refusal never happens and the assertion never runs against
 * what it names. The Docker/Debian clean room runs as root.
 *
 * PROBED, NOT INFERRED FROM THE UID. `process.getuid() === 0` is the shorthand
 * elsewhere in this suite, and it answers a different question: a non-root
 * process holding `CAP_DAC_OVERRIDE`, or a filesystem mounted so permissions do
 * not apply, also defeats the fixture while reporting a perfectly ordinary uid.
 * The condition that matters is whether a refusal can be staged at all, so that
 * is what this asks.
 *
 * Callers `t.skip()` on a false answer rather than returning silently, so the
 * run says which tests did not execute. Each such skip is on
 * `test/skip-ledger.json` under `eacces-fixtures`, matched by the
 * "(needs a directory this process cannot read)" suffix every one of them
 * carries — a silent early return would let the tier disappear from a green run
 * with nothing saying so.
 *
 * @returns {boolean} True when a `chmod 000` directory genuinely refuses to be
 *   read by this process.
 */
function canForceRefusal() {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-eacces-probe-'));
  try {
    fs.chmodSync(probe, 0o000);
    fs.readdirSync(probe);
    return false; // it answered anyway — this process outranks the mode bits
  } catch {
    return true;
  } finally {
    try {
      fs.chmodSync(probe, 0o755);
      fs.rmSync(probe, { recursive: true, force: true });
    } catch {
      // The probe directory is disposable; failing to clean it up is not a
      // reason to fail the suite.
    }
  }
}

/** The suffix every refusal-dependent test title carries, so one ledger pattern covers the tier. */
const NEEDS_REFUSAL = '(needs a directory this process cannot read)';

module.exports = { canForceRefusal, NEEDS_REFUSAL };
