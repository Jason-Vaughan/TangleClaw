'use strict';

/**
 * Bring an ALREADY-INSTALLED ttyd launchd job into line with the configured
 * network binding.
 *
 * `deploy/install.sh` writes the ttyd plist once, at install time. A TangleClaw
 * update is a `git checkout` — it never rewrites launchd plists. So a machine
 * installed before ttyd was pinned to loopback keeps its original job
 * definition, and updating changes nothing about it: the terminal stays
 * reachable from the whole network even though the dashboard no longer is.
 *
 * That is not a cosmetic gap. ttyd runs `--writable` against a script that
 * ends in `exec tmux attach-session`, so an unpinned job is an unauthenticated
 * shell on the LAN. Closing it for fresh installs only would leave every
 * existing operator exposed while the release notes say otherwise.
 *
 * **Why this edits rather than regenerates.** Regenerating the plist would mean
 * re-deriving every substitution install.sh made (ttyd path, PATH, the non-TCC
 * attach-script location) and getting all of them right on a machine we cannot
 * see. Instead this performs the smallest possible edit: it swaps the bind
 * arguments inside the existing `ProgramArguments` and leaves every other byte
 * alone. Anything it does not recognize, it refuses to touch.
 *
 * **Why it is conservative.** The operator this runs on is remote, and a ttyd
 * job that fails to start takes every terminal with it. So: refuse on anything
 * unexpected, back up before writing, validate the result before installing it,
 * and treat "I am not sure" as "do nothing and say so".
 *
 * @module lib/ttyd-bind
 */

const LOOPBACK = '127.0.0.1';
const ALL_INTERFACES = '0.0.0.0';

/**
 * The bind arguments this machine's ttyd job should be running with.
 *
 * Caddy mode is deliberately excluded: there ttyd binds a Unix socket, which is
 * already unreachable over the network and is owned by the ingress cutover.
 *
 * @param {object} config - Global config.
 * @returns {{manage: boolean, iface: (string|null), reason: string}} `manage`
 *   false means this module has no opinion and must not touch the plist.
 */
function desiredBind(config) {
  const cfg = config || {};
  if (cfg.ingressMode === 'caddy') {
    return { manage: false, iface: null, reason: 'caddy-mode-owns-the-socket' };
  }
  // Unconditionally loopback — this does NOT follow `bindAllInterfaces`.
  //
  // That setting exists so an operator can reach the DASHBOARD from another
  // device. Nothing ever needs to reach ttyd directly: TangleClaw proxies to
  // `127.0.0.1:<ttydPort>` and the browser only loads a same-origin terminal
  // route, so widening this port grants no capability the operator wanted and
  // publishes a `--writable` shell that execs `tmux attach-session`.
  //
  // Coupling it to the opt-in was a real hazard, not a hypothetical one: any
  // path that set `bindAllInterfaces: true` would silently re-open this port on
  // the next restart, undoing the fix without anyone choosing to.
  return { manage: true, iface: LOOPBACK, reason: 'terminal-is-never-addressed-directly' };
}

/**
 * Extract the ordered `ProgramArguments` strings from a launchd plist.
 *
 * @param {string} xml - Raw plist contents.
 * @returns {{args: string[], blockStart: number, blockEnd: number}|null} Null when
 *   the block is absent or malformed — the caller must then refuse.
 */
function parseProgramArguments(xml) {
  if (typeof xml !== 'string') return null;
  const keyIdx = xml.indexOf('<key>ProgramArguments</key>');
  if (keyIdx === -1) return null;
  const arrStart = xml.indexOf('<array>', keyIdx);
  const arrEnd = xml.indexOf('</array>', arrStart);
  if (arrStart === -1 || arrEnd === -1) return null;
  const block = xml.slice(arrStart, arrEnd);
  const args = [...block.matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => m[1]);
  return { args, blockStart: arrStart, blockEnd: arrEnd };
}

/**
 * Is this `--interface` value one that only the local machine can reach?
 * ttyd takes an address or an interface name, so both spellings of loopback
 * count. Anything else — a LAN address, `0.0.0.0`, `en0` — is reachable from
 * off the box and is NOT loopback, whether or not this list has heard of it.
 *
 * @param {string} iface - The bound interface.
 * @returns {boolean}
 */
function isLoopbackBind(iface) {
  if (iface === LOOPBACK || iface === '::1' || iface === 'localhost') return true;
  if (iface === 'lo' || iface === 'lo0') return true;
  return /^127\.\d+\.\d+\.\d+$/.test(iface);
}

/**
 * Describe how an installed job currently binds.
 *
 * `wide` is derived from what the bind is NOT — neither loopback nor a unix
 * socket — rather than by listing the wide shapes (#1056). The list form
 * (`0.0.0.0`, or no `--interface` at all) reported a job hand-bound to a LAN
 * address as not-wide, so the "still accepting connections from your whole
 * network" notice that reads this field stayed silent on exactly the job it
 * describes. The bias is unchanged: a bind this function cannot classify is
 * treated as exposed, because a false alarm costs a notice and silence costs
 * an open shell.
 *
 * @param {string[]} args - ProgramArguments strings.
 * @returns {{iface: (string|null), port: (string|null), wide: boolean}} `wide` is
 *   true when the job is reachable from off the machine — an explicit
 *   `0.0.0.0`, a LAN address or interface, or (the pre-#710 shape) no
 *   `--interface` at all, which is ttyd's every-interface default. Loopback
 *   in any spelling and a unix-socket path report `wide: false`; the socket's
 *   path is `iface`.
 */
function describeInstalledBind(args) {
  const list = Array.isArray(args) ? args : [];
  const ifaceAt = list.indexOf('--interface');
  const portAt = list.indexOf('--port');
  const iface = ifaceAt !== -1 && ifaceAt + 1 < list.length ? list[ifaceAt + 1] : null;
  const port = portAt !== -1 && portAt + 1 < list.length ? list[portAt + 1] : null;
  const wide = iface === null || !(isLoopbackBind(iface) || iface.startsWith('/'));
  return { iface, port, wide };
}

/**
 * Decide what to do about an installed plist, without touching anything.
 *
 * Separated from the apply step so the decision is exhaustively testable
 * without launchd, a filesystem, or a remote operator's machine.
 *
 * @param {string} xml - The installed plist.
 * @param {object} config - Global config.
 * @returns {{action: 'none'|'rewrite'|'refuse', reason: string, from: (string|null),
 *   to: (string|null), xml: (string|null), stillWide: boolean}} `xml` carries the
 *   rewritten plist for the `rewrite` action, and is null otherwise. `stillWide`
 *   describes the job AS IT STANDS — whether it is currently listening on every
 *   interface — never the state a successful apply would produce. Callers use it
 *   to decide whether a refusal (or a failed apply) leaves an unauthenticated
 *   shell exposed, and every return shape carries it.
 */
function planReconcile(xml, config) {
  const desired = desiredBind(config);
  if (!desired.manage) {
    return { action: 'none', reason: desired.reason, from: null, to: null, xml: null, stillWide: false };
  }

  const parsed = parseProgramArguments(xml);
  if (!parsed) {
    return {
      action: 'refuse',
      reason: 'unreadable-plist: no parseable ProgramArguments block',
      // Unknown, so assume the worse of the two. A false alarm costs a notice;
      // staying quiet about a real one costs an open shell.
      from: null, to: desired.iface, xml: null, stillWide: true
    };
  }

  const { args } = parsed;
  // Only ever touch a job we recognize as ours. A plist that does not run ttyd
  // in the shape we install is somebody else's problem, and rewriting it blind
  // is how a remote operator loses their terminal.
  const looksLikeOurs = args.includes('--writable') && args.includes('--url-arg');
  if (!looksLikeOurs) {
    return {
      action: 'refuse',
      reason: 'unrecognized-job: missing the --writable/--url-arg shape this project installs',
      from: null, to: desired.iface, xml: null,
      stillWide: describeInstalledBind(args).wide
    };
  }

  const current = describeInstalledBind(args);

  // A unix socket means caddy-mode wiring is live even though config says
  // direct. Config and reality disagree; that is the cutover's business, not
  // ours, and silently converting a socket job to TCP would expose it.
  if (current.iface && current.iface.startsWith('/')) {
    return {
      action: 'refuse',
      reason: 'socket-bound: job is on a unix socket (caddy wiring) while config says direct — cutover owns this',
      // A unix socket is not reachable over the network at all.
      from: current.iface, to: desired.iface, xml: null, stillWide: false
    };
  }

  if (current.iface === desired.iface) {
    return {
      action: 'none', reason: 'already-correct',
      from: current.iface, to: desired.iface, xml: null, stillWide: current.wide
    };
  }

  const rewritten = rewriteBindArgs(xml, parsed, current, desired.iface);
  if (!rewritten) {
    return {
      action: 'refuse',
      reason: 'unsafe-edit: could not place the interface argument without disturbing other args',
      from: current.iface, to: desired.iface, xml: null, stillWide: current.wide
    };
  }

  return {
    action: 'rewrite',
    reason: current.iface === null ? 'no-interface-arg (pre-#710 wide bind)' : 'interface-changed',
    from: current.iface, to: desired.iface, xml: rewritten,
    // A PLAN describes the job as it stands, not as it would be afterwards.
    // The only reader of this field on a rewrite plan is the staging-failure
    // path, which is reached when the live plist was never touched — so the
    // honest answer there is the CURRENT job's exposure. Reporting the intended
    // post-apply state (`false`) told an operator whose write failed that their
    // door was shut, and suppressed the very chip that exists to say otherwise.
    stillWide: current.wide
  };
}

/**
 * Produce a plist identical to the input except for the ttyd interface argument.
 *
 * Two shapes are handled: an existing `--interface <val>` pair gets its value
 * replaced, and a job with no interface at all (every pre-#710 install) gets one
 * inserted immediately before `--port`. Anything else returns null so the caller
 * refuses rather than guesses.
 *
 * @param {string} xml - The installed plist.
 * @param {{args: string[], blockStart: number, blockEnd: number}} parsed
 * @param {{iface: (string|null), port: (string|null)}} current
 * @param {string} iface - Desired interface value.
 * @returns {string|null} The rewritten plist, or null when it cannot be done safely.
 */
function rewriteBindArgs(xml, parsed, current, iface) {
  const block = xml.slice(parsed.blockStart, parsed.blockEnd);

  if (current.iface !== null) {
    // Replace the value that follows the --interface key, and nothing else.
    const re = /(<string>--interface<\/string>\s*<string>)([\s\S]*?)(<\/string>)/;
    if (!re.test(block)) return null;
    const nextBlock = block.replace(re, `$1${iface}$3`);
    return xml.slice(0, parsed.blockStart) + nextBlock + xml.slice(parsed.blockEnd);
  }

  // No interface argument at all. Insert one ahead of --port so the resulting
  // order matches what install.sh now writes.
  const portRe = /(\n(\s*)<string>--port<\/string>)/;
  const m = block.match(portRe);
  if (!m) return null;
  const indent = m[2];
  const inserted = `\n${indent}<string>--interface</string>\n${indent}<string>${iface}</string>${m[1]}`;
  const nextBlock = block.replace(portRe, inserted);
  return xml.slice(0, parsed.blockStart) + nextBlock + xml.slice(parsed.blockEnd);
}

/**
 * Apply the plan to the installed launchd job, reversibly.
 *
 * Order matters and every step is undoable, because this runs unattended on a
 * machine nobody is sitting at: back up, write to a temporary file, prove the
 * result is a valid plist BEFORE it replaces anything, swap it in, reload, then
 * confirm ttyd actually came back. If the reload does not produce a listening
 * job, the backup goes back and the job is reloaded again — an operator must
 * never be left with a terminal that does not start because of a change they
 * did not ask for.
 *
 * Every failure is non-fatal. The dashboard binding and the server are unaffected
 * by anything here, so a refusal or an error is logged and life goes on; the next
 * boot tries again.
 *
 * @param {object} opts
 * @param {string} opts.home - Home directory (plist location).
 * @param {object} opts.config - Global config.
 * @param {object} opts.deps - Injected `{ fs, path, execFileSync, uid, log, probe }`.
 *   `probe(port)` returns true when something is listening on loopback:port.
 * @returns {{action: string, reason: string, rolledBack?: boolean, stillWide: boolean}}
 *   `stillWide` is true when the terminal is left listening on every interface —
 *   after a refusal, a failed staging, or a rollback. The caller raises the
 *   operator-facing exposure notice from it.
 */
function reconcileInstalledJob({ home, config, deps }) {
  const { fs, path, execFileSync, uid, log, probe } = deps;
  const plistPath = path.join(home, 'Library', 'LaunchAgents', 'com.tangleclaw.ttyd.plist');
  const label = 'com.tangleclaw.ttyd';

  if (!fs.existsSync(plistPath)) return { action: 'none', reason: 'no-installed-plist', stillWide: false };

  let plan;
  try {
    plan = planReconcile(fs.readFileSync(plistPath, 'utf8'), config);
  } catch (err) {
    return { action: 'refuse', reason: `unreadable: ${err.message}`, stillWide: true };
  }
  if (plan.action !== 'rewrite') return plan;

  const backupPath = `${plistPath}.bak-before-bind-pin`;
  const tmpPath = `${plistPath}.new`;
  try {
    fs.copyFileSync(plistPath, backupPath);
    fs.writeFileSync(tmpPath, plan.xml);
    // A malformed plist makes launchd refuse the job outright, so this check is
    // the difference between "terminal keeps working" and "terminal is gone".
    execFileSync('plutil', ['-lint', tmpPath], { timeout: 5000, stdio: 'ignore' });
    fs.renameSync(tmpPath, plistPath);
  } catch (err) {
    try { fs.rmSync(tmpPath, { force: true }); } catch { /* nothing to clean */ }
    log.warn('ttyd bind pin aborted before touching the live job', { error: err.message });
    // Nothing was installed, so the job is exactly as the plan found it.
    // Written as `!== false` rather than `=== true` to hold this module's stated
    // bias (see describeInstalledBind): a missing or unknown value must fail
    // toward warning. They are identical while the plan guarantees a boolean —
    // the point is that if that guarantee ever lapses, this errs toward telling
    // the operator about an open shell rather than staying quiet about one.
    return { action: 'refuse', reason: `staging-failed: ${err.message}`, stillWide: plan.stillWide !== false };
  }

  const reload = () => {
    // bootout can legitimately fail when the job is not loaded; bootstrap is the
    // one that must succeed.
    try { execFileSync('launchctl', ['bootout', `gui/${uid}/${label}`], { timeout: 10000, stdio: 'ignore' }); } catch { /* not loaded */ }
    execFileSync('launchctl', ['bootstrap', `gui/${uid}`, plistPath], { timeout: 10000, stdio: 'ignore' });
  };

  try {
    reload();
    if (probe && !probe(config.ttydPort || 3100)) throw new Error('ttyd did not come back listening');
    log.info('Pinned the installed ttyd job to its configured interface', {
      from: plan.from === null ? '(no --interface — every interface)' : plan.from,
      to: plan.to, backup: backupPath
    });
    return { action: 'rewrite', reason: plan.reason, stillWide: false };
  } catch (err) {
    // Restoring the FILE and reloading it are separate outcomes, and conflating
    // them misreports the operator's actual situation. A restored plist that
    // could not be reloaded is recoverable by a reboot; a plist that was never
    // restored needs hands on the machine. Say which one happened.
    let restored = false;
    try {
      fs.copyFileSync(backupPath, plistPath);
      restored = true;
      reload();
      log.error('ttyd did not come back after the bind pin — restored and reloaded the previous job', {
        error: err.message
      });
      // Rolled back to the previous job, which is the wide one we set out to fix.
      return { action: 'refuse', reason: `reload-failed: ${err.message}`, rolledBack: true, stillWide: true };
    } catch (restoreErr) {
      log.error(
        restored
          ? 'Restored the previous ttyd job, but could not reload it — it will take effect on next login/reboot'
          : 'ttyd bind pin failed AND the previous job could not be restored — fix by hand',
        {
          error: restoreErr.message, backup: backupPath, plist: plistPath,
          hint: `cp "${backupPath}" "${plistPath}" && launchctl bootstrap gui/${uid} "${plistPath}"`
        }
      );
      return {
        action: 'refuse',
        reason: restored ? `restored-but-reload-failed: ${restoreErr.message}`
          : `rollback-failed: ${restoreErr.message}`,
        rolledBack: restored, stillWide: true
      };
    }
  }
}

module.exports = {
  desiredBind,
  reconcileInstalledJob,
  parseProgramArguments,
  describeInstalledBind,
  isLoopbackBind,
  planReconcile,
  rewriteBindArgs,
  LOOPBACK,
  ALL_INTERFACES
};
