'use strict';

// Shared `caddy` stub for suites whose behavior depends on whether Caddy is
// installed.
//
// Why this exists: `caddy.detectCaddy()` shells out to `caddy version`, so a
// suite that does not control PATH inherits whatever the host happens to have.
// Every developer machine here has Caddy — the live install uses it — and CI
// does not. Three suites silently depended on that difference and passed
// locally while failing 17 assertions on CI, which went unnoticed because CI
// had never run the branch. The lesson is not "stub it in this file": it is that
// the next suite to test an ingress decision must inherit the stub rather than
// rediscover the problem, so the stub lives in one place. All four suites that
// need it consume this module — three want Caddy present, `auth2-setup-admin`
// wants it absent and says so explicitly at the call site rather than relying on
// a default, because flipping that one silently would gut its assertions.
//
// Deliberately NOT named `*.test.js`: the suite command is
// `node --test 'test/*.test.js'`, and a helper collected as a test file would
// report as an empty suite.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Write an executable `caddy` stub into `dir`.
 *
 * `hash-password` always answers, because setup hashes a credential on the happy
 * path. `version` is opt-out rather than opt-in: a present-and-working Caddy is
 * what most callers need, and a suite that wants the absent case should use
 * `withoutCaddy` (below) instead of a stub that half-works — a binary that
 * exists but fails `version` is a third state, and only one suite deliberately
 * exercises it.
 *
 * @param {string} dir - Directory to write the stub into. Must exist.
 * @param {object} [opts]
 * @param {boolean} [opts.answersVersion=true] - Whether `caddy version` succeeds.
 * @param {boolean} [opts.answersValidate=true] - Whether `caddy validate` accepts the file.
 * @returns {string} Path to the stub.
 */
function writeCaddyStub(dir, opts = {}) {
  const answersVersion = opts.answersVersion !== false;
  const answersValidate = opts.answersValidate !== false;
  // `validate` accepts by default. A stub that rejected everything would make any
  // caller that writes a Caddyfile look like it produced a broken one, which is
  // the opposite of the failure a test usually wants to isolate. Opt out to
  // exercise the fail-closed restore path.
  const validateCase = answersValidate
    ? `  validate)
    exit 0
    ;;
`
    : '';
  const versionCase = answersVersion
    ? `  version)
    echo 'v2.8.4 h1:stub'
    exit 0
    ;;
`
    : '';
  const script = `#!/bin/bash
case "$1" in
${versionCase}  hash-password)
    read -r pw
    echo '\$2a\$14\$abcdefghijklmnopqrstuv0123456789ABCDEFGHIJKLMNOPQRSTU'
    exit 0
    ;;
${validateCase}esac
echo "caddy stub: unknown args: $*" >&2
exit 1
`;
  const p = path.join(dir, 'caddy');
  fs.writeFileSync(p, script, { mode: 0o755 });
  return p;
}

/**
 * Write an executable `launchctl` stub that records its argv and succeeds.
 *
 * Not optional, and not cosmetic. Changing a credential ends in
 * `launchctl kickstart -k gui/<uid>/com.tangleclaw.caddy`, and the real binary is
 * on PATH on the machine that runs these tests — so without this, the suite
 * restarts the developer's own live Caddy, dropping their remote access mid-run.
 * That is a test reaching outside its sandbox and touching the machine, which no
 * assertion is worth. Recording the argv means the reload can still be asserted:
 * the stub proves the call was made without making it for real.
 *
 * @param {string} dir - Directory to write the stub into. Must exist.
 * @returns {string} Path to the invocation log the stub appends to.
 */
function writeLaunchctlStub(dir) {
  const logPath = path.join(dir, 'launchctl-invocations.log');
  const script = `#!/bin/bash
echo "$*" >> ${JSON.stringify(logPath)}
exit 0
`;
  fs.writeFileSync(path.join(dir, 'launchctl'), script, { mode: 0o755 });
  return logPath;
}

/**
 * Put a stubbed `caddy` and `launchctl` on PATH for the duration of a suite.
 *
 * Returns a restore function rather than mutating global state irreversibly, so
 * a suite's `after` hook puts PATH back even when an assertion throws.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.answersVersion=true] - Passed through to `writeCaddyStub`.
 * @param {boolean} [opts.answersValidate=true] - Passed through to `writeCaddyStub`.
 * @returns {{ dir: string, launchctlLog: string, restore: Function }} The stub
 *   dir, the path the launchctl stub appends each invocation to, and the undo.
 */
function installCaddyStub(opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-caddy-stub-'));
  writeCaddyStub(dir, opts);
  const launchctlLog = writeLaunchctlStub(dir);
  const origPath = process.env.PATH;
  process.env.PATH = dir + path.delimiter + (origPath || '');
  return {
    dir,
    launchctlLog,
    restore() {
      process.env.PATH = origPath;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };
}

/**
 * Run `fn` with an empty PATH, so `caddy` (and everything else) is absent.
 *
 * The absent case is a real product state — setup must finish honestly ungated
 * on a machine with no Caddy — so it needs to be reachable deliberately rather
 * than by accident of the host.
 *
 * @param {Function} fn - Called with no arguments; may be async.
 * @returns {Promise<*>} Whatever `fn` returns.
 */
async function withoutCaddy(fn) {
  const emptyBin = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-nocaddy-'));
  const origPath = process.env.PATH;
  process.env.PATH = emptyBin;
  try {
    return await fn();
  } finally {
    process.env.PATH = origPath;
    fs.rmSync(emptyBin, { recursive: true, force: true });
  }
}

module.exports = { writeCaddyStub, writeLaunchctlStub, installCaddyStub, withoutCaddy };
