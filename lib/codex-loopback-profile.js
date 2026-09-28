'use strict';

/**
 * The loopback-only network profile Codex's Full Auto mode runs under (#1836).
 *
 * Every `tc` verb is loopback HTTP to the TangleClaw server, and Codex's
 * `workspace-write` sandbox refuses every connection, loopback included, so a
 * Full Auto session could never read its own launch sequence. Opening the
 * sandbox's network outright (`sandbox_workspace_write.network_access=true`)
 * gives the agent the internet and the LAN too. Codex's permission profiles
 * with its managed network proxy can do narrower: the proxy is the only exit
 * from the sandbox, it refuses loopback and private addresses unless a host
 * is allowlisted, and it answers every other host with a denial.
 *
 * This module is the ONE place that profile is written down, so every launch
 * path that applies it applies exactly the same restriction. It is pure: no
 * version probe, no process, no file. Which binaries may run it is decided by
 * the Codex adapter from the version it probed.
 *
 * What the profile grants, measured on codex-cli 0.156.1 in a real TUI turn:
 * - `127.0.0.1` and `localhost`, every port on them. Codex's proxy drops a
 *   `:port` from a domain rule, so no rule can narrow this to the TangleClaw
 *   port; a Full Auto session reaches every service listening on loopback.
 * - Nothing else: direct sockets bypassing the proxy, public hosts, the LAN,
 *   this machine's own LAN and tailnet addresses, and DNS to an outside
 *   resolver are all refused.
 * - The same filesystem as `workspace-write`. A custom profile extending
 *   `:workspace` does NOT inherit that mode's read-only `.git`, `.agents` and
 *   `.codex` inside the workspace, so they are restated here; without them the
 *   agent can rewrite the repository's hooks and history.
 *
 * The profile only takes effect when Codex's CLI is NOT also given
 * `--sandbox`: that flag selects the legacy sandbox syntax, whose network
 * proxy is empty. `applyLoopbackProfile` therefore replaces the mode's
 * `--sandbox workspace-write` rather than adding to it.
 *
 * Loopback is not neutral ground on this machine, so the profile is applied
 * only with a grant from `lib/loopback-trust-guard.js` (#1957): ttyd off TCP,
 * and loopback API access behind the service token. Without one,
 * `applyLoopbackProfile` refuses whatever the command.
 */

const loopbackTrust = require('./loopback-trust-guard');

/** The profile's name inside Codex's config. */
const PROFILE_NAME = 'tangleclaw-loopback';

/** The only hosts the proxy may reach. Exact names, never a wildcard or a port. */
const LOOPBACK_HOSTS = Object.freeze(['127.0.0.1', 'localhost']);

/** Workspace paths `workspace-write` keeps read-only, restated for the profile. */
const READ_ONLY_WORKSPACE_PATHS = Object.freeze(['.git', '.agents', '.codex']);

/** The legacy flag pair the profile replaces in a launch command. */
const LEGACY_SANDBOX_PAIR = Object.freeze(['--sandbox', 'workspace-write']);

/**
 * Render a JSON-style inline TOML table from ordered `[key, value]` pairs.
 * Keys and values here are fixed strings from this module, never input.
 * @param {Array<[string, string]>} pairs - Entries in order.
 * @returns {string} e.g. `{"127.0.0.1"="allow","localhost"="allow"}`
 */
function _inlineTable(pairs) {
  return `{${pairs.map(([k, v]) => `${JSON.stringify(k)}=${JSON.stringify(v)}`).join(',')}}`;
}

/**
 * The profile as Codex CLI arguments, one argv token per element: the `-c`
 * overrides that define the profile, select it, and turn on the proxy it
 * needs. `network.enabled` is never emitted without `features.network_proxy`:
 * without the proxy, an enabled network is not a restricted one.
 * @returns {string[]}
 */
function profileArgs() {
  const p = `permissions.${PROFILE_NAME}`;
  const filesystem = _inlineTable([['.', 'write'], ...READ_ONLY_WORKSPACE_PATHS.map((d) => [d, 'read'])]);
  const domains = _inlineTable(LOOPBACK_HOSTS.map((h) => [h, 'allow']));
  return [
    '-c', 'features.network_proxy=true',
    '-c', `default_permissions=${JSON.stringify(PROFILE_NAME)}`,
    '-c', `${p}.extends=":workspace"`,
    // Codex rejects this key when `:workspace_roots` is quoted; bare is the
    // spelling its parser accepts for the special path.
    '-c', `${p}.filesystem.:workspace_roots=${filesystem}`,
    '-c', `${p}.network.enabled=true`,
    '-c', `${p}.network.domains=${domains}`
  ];
}

/**
 * Quote one argv token for a POSIX shell. Tokens made only of characters no
 * shell interprets stay bare so the command stays readable.
 * @param {string} token - One argument.
 * @returns {string}
 */
function shellQuote(token) {
  if (/^[A-Za-z0-9_.,:\/=+-]+$/.test(token)) return token;
  return `'${token.replace(/'/g, `'\\''`)}'`;
}

/** Matches an exact, whitespace-delimited `--sandbox workspace-write`. */
const LEGACY_SANDBOX_RE = new RegExp(`(^|\\s)${LEGACY_SANDBOX_PAIR.join('\\s+')}(?=\\s|$)`);

/**
 * Whether a launch command runs Codex's `workspace-write` sandbox, the one
 * that refuses every connection, loopback included.
 * @param {string} launchCmd - A shell command assembled from argv tokens.
 * @returns {boolean}
 */
function hasLegacySandbox(launchCmd) {
  return typeof launchCmd === 'string' && LEGACY_SANDBOX_RE.test(launchCmd);
}

/**
 * Put the profile in place of the legacy sandbox flags in a launch command.
 * Only an exact, whitespace-delimited `--sandbox workspace-write` is
 * replaced; a command without it is returned unchanged with `applied: false`,
 * so this never adds a network grant to a mode that had no sandbox to narrow.
 * Without a granting verdict from `lib/loopback-trust-guard.js` the command is
 * also returned unchanged: the profile is never applied on trust that was not
 * checked.
 * @param {string} launchCmd - A shell command assembled from argv tokens.
 * @param {object} trust - A verdict from `loopbackTrust.assessLoopbackTrust`.
 * @returns {{command: string, applied: boolean}}
 */
function applyLoopbackProfile(launchCmd, trust) {
  if (!loopbackTrust.isGranted(trust)) return { command: launchCmd, applied: false };
  if (!hasLegacySandbox(launchCmd)) return { command: launchCmd, applied: false };
  const replacement = profileArgs().map(shellQuote).join(' ');
  return { command: launchCmd.replace(LEGACY_SANDBOX_RE, (_m, lead) => `${lead}${replacement}`), applied: true };
}

module.exports = {
  PROFILE_NAME,
  LOOPBACK_HOSTS,
  READ_ONLY_WORKSPACE_PATHS,
  profileArgs,
  shellQuote,
  hasLegacySandbox,
  applyLoopbackProfile
};
