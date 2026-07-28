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
  return {
    manage: true,
    iface: cfg.bindAllInterfaces === true ? ALL_INTERFACES : LOOPBACK,
    reason: cfg.bindAllInterfaces === true ? 'operator-opted-in' : 'default-loopback'
  };
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
 * Describe how an installed job currently binds.
 *
 * @param {string[]} args - ProgramArguments strings.
 * @returns {{iface: (string|null), port: (string|null), wide: boolean}} `wide` is
 *   true when ttyd would listen on every interface — either an explicit
 *   `0.0.0.0` or, the pre-#710 shape, no `--interface` at all. A unix-socket
 *   interface reports `wide: false` and its path as `iface`.
 */
function describeInstalledBind(args) {
  const list = Array.isArray(args) ? args : [];
  const ifaceAt = list.indexOf('--interface');
  const portAt = list.indexOf('--port');
  const iface = ifaceAt !== -1 && ifaceAt + 1 < list.length ? list[ifaceAt + 1] : null;
  const port = portAt !== -1 && portAt + 1 < list.length ? list[portAt + 1] : null;
  // No interface at all is ttyd's default, which is every interface. That is
  // precisely the shape every pre-#710 install is running.
  const wide = iface === null || iface === ALL_INTERFACES;
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
 *   to: (string|null), xml: (string|null)}} `xml` carries the rewritten plist for
 *   the `rewrite` action, and is null otherwise.
 */
function planReconcile(xml, config) {
  const desired = desiredBind(config);
  if (!desired.manage) {
    return { action: 'none', reason: desired.reason, from: null, to: null, xml: null };
  }

  const parsed = parseProgramArguments(xml);
  if (!parsed) {
    return {
      action: 'refuse',
      reason: 'unreadable-plist: no parseable ProgramArguments block',
      from: null, to: desired.iface, xml: null
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
      from: null, to: desired.iface, xml: null
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
      from: current.iface, to: desired.iface, xml: null
    };
  }

  if (current.iface === desired.iface) {
    return { action: 'none', reason: 'already-correct', from: current.iface, to: desired.iface, xml: null };
  }

  const rewritten = rewriteBindArgs(xml, parsed, current, desired.iface);
  if (!rewritten) {
    return {
      action: 'refuse',
      reason: 'unsafe-edit: could not place the interface argument without disturbing other args',
      from: current.iface, to: desired.iface, xml: null
    };
  }

  return {
    action: 'rewrite',
    reason: current.iface === null ? 'no-interface-arg (pre-#710 wide bind)' : 'interface-changed',
    from: current.iface, to: desired.iface, xml: rewritten
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

module.exports = {
  desiredBind,
  parseProgramArguments,
  describeInstalledBind,
  planReconcile,
  rewriteBindArgs,
  LOOPBACK,
  ALL_INTERFACES
};
