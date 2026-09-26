#!/usr/bin/env node
'use strict';

/**
 * Command-line front end for the owned ttyd runtime (#1245, ADR 0018); the
 * logic lives in lib/ttyd-runtime.js.
 *
 *   provision            make sure a current, verified runtime is installed —
 *                        building and installing one when it is absent, invalid
 *                        or stale — then print the ttyd path launchd should run
 *                        (stdout only), or exit 3 naming the repair. Used by
 *                        deploy/install.sh. Never builds under the explicit
 *                        Homebrew rollback.
 *   resolve              print the ttyd path launchd should run (stdout only), or
 *                        exit 3 naming the repair. Never builds.
 *   install --from DIR   install a runtime staged by scripts/build-ttyd.js,
 *                        fail-closed, keeping the current one as last known good
 *   rollback             restore the last known good runtime
 *   status               report which ttyd is selected (or why none is), and
 *                        the current and last-known-good runtimes
 *
 *   --base-dir DIR       the TangleClaw base directory to act on (default: the
 *                        install's own, which honours TANGLECLAW_HOME). install.sh
 *                        passes the one it writes everything else under, so a
 *                        stray TANGLECLAW_HOME cannot split one install in two.
 *
 * `provision`, `install` and `rollback` change only files under
 * ~/.tangleclaw/bin (and a temporary build directory). None of them edits a
 * plist or restarts ttyd: those follow through install.sh or the
 * ingress cutover, under Operator/PM authority.
 */

const path = require('node:path');
const tangleclawHome = require('../lib/tangleclaw-home');
const runtime = require('../lib/ttyd-runtime');

/**
 * Run one subcommand.
 * @param {string[]} argv - `process.argv.slice(2)`.
 * @param {{baseDir: string, env: object, out: Function, err: Function, deps?: object}} io
 * @returns {number} Exit code.
 */
function main(argv, io) {
  const args = [...argv];
  let baseDir = io.baseDir;
  const at = args.indexOf('--base-dir');
  if (at !== -1) {
    if (!args[at + 1]) { io.err('--base-dir needs a directory'); return 2; }
    baseDir = path.resolve(args[at + 1]);
    args.splice(at, 2);
  }
  const [cmd, ...rest] = args;
  try {
    if (cmd === 'provision') {
      const r = runtime.provisionRuntime({ baseDir, env: io.env, deps: io.deps, log: (s) => io.err(s) });
      if (r.warning) io.err(`WARNING: ${r.warning}`);
      else if (r.built) io.err(`built and installed the owned ttyd runtime ${r.installed}`);
      io.out(r.path);
      return 0;
    }
    if (cmd === 'resolve') {
      const r = runtime.resolveTtydPath({ baseDir, env: io.env, deps: io.deps });
      if (r.warning) io.err(`WARNING: ${r.warning}`);
      io.out(r.path);
      return 0;
    }
    if (cmd === 'install') {
      const at = rest.indexOf('--from');
      if (at === -1 || !rest[at + 1]) { io.err('usage: ttyd-runtime.js install --from <stage-dir>'); return 2; }
      const r = runtime.installRuntime({ baseDir, stageDir: path.resolve(rest[at + 1]), deps: io.deps });
      io.out(`installed ${r.installed}${r.keptPrevious ? `; last known good is ${r.previous}` : '; there was no verified runtime to keep as last known good'}`);
      io.out(`ttyd has NOT been restarted: to run it, ${runtime.SELECT_BY_MODE}.`);
      return 0;
    }
    if (cmd === 'rollback') {
      const r = runtime.rollbackRuntime({ baseDir, deps: io.deps });
      io.out(`restored ${r.restored}${r.setAside ? `; the replaced runtime is kept at ${r.setAside}` : ''}`);
      io.out('ttyd has NOT been restarted. If the ttyd plist already runs ~/.tangleclaw/bin/ttyd, '
        + '`launchctl kickstart -k gui/$(id -u)/com.tangleclaw.ttyd` restarts it on the restored runtime; otherwise, '
        + `${runtime.SELECT_BY_MODE}.`);
      return 0;
    }
    if (cmd === 'status') {
      io.out(JSON.stringify(runtime.runtimeStatus({ baseDir, env: io.env, deps: io.deps }), null, 2));
      return 0;
    }
    io.err('usage: ttyd-runtime.js provision | resolve | install --from <stage-dir> | rollback | status');
    return 2;
  } catch (err) {
    if (err instanceof runtime.RuntimeUnavailableError) {
      io.err(err.message);
      return 3;
    }
    throw err;
  }
}

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2), {
    baseDir: tangleclawHome.baseDir(),
    env: process.env,
    out: (s) => process.stdout.write(`${s}\n`),
    err: (s) => process.stderr.write(`${s}\n`)
  });
}

module.exports = { main };
