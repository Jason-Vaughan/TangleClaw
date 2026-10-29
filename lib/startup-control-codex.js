'use strict';

/**
 * The Codex startupControl adapter (#1825): TangleClaw's side of
 * Codex's app-server protocol, behind the generic adapter contract in
 * `docs/engine-guide.md` ("startupControl"). Nothing outside this module
 * knows about sockets, threads, turns or the app-server: the generic channel
 * row carries only a lifecycle header, and everything Codex-specific lives in
 * its `adapterState`, which only this module reads or writes.
 *
 * What it owns, per launch:
 * - a `codex app-server --listen unix://…` process, spawned DETACHED in its
 *   own process group before the pane exists, so a TangleClaw restart does not
 *   sever the pane's server; recorded with its birth identity so a reused pid
 *   can never be signalled by mistake;
 * - the pane's command, `codex --remote unix://<resolved> <launch-mode args>`,
 *   with the already-validated argv kept verbatim after `--remote`;
 * - readiness, read from the protocol. The pane is consulted in one case only,
 *   by a witness the fire service supplies (see `_withoutTrustEntry`): the server's
 *   version against the installed and the recorded one, the project's trust in
 *   Codex's own config, the account, the quota, exactly one thread for the
 *   project directory (the recorded one once seen), and its idle status; an
 *   unknown answer fails closed with a typed reason, never as ready;
 * - the fire: `turn/start` carrying the launch-start payload digest as
 *   `clientUserMessageId`; the engine echoes it on the user item, and the item's
 *   content must hash to the prompt's text digest, so a receipt is bound by the
 *   engine to this launch AND to these bytes;
 * - the receipt transitions, driven by the engine's notifications and by
 *   read-backs of the engine's own turn record; recovery of every in-flight
 *   fire after a TangleClaw restart, without resending anything.
 *
 * Measured against codex-cli 0.156.1 (the spike, and the six probes recorded
 * in the plan). The fact that shapes the fire path: a fresh thread cannot be
 * subscribed to or listed before its first user message, so the subscription
 * and the read-back FOLLOW the `turn/start` response.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync, execFile, execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');

const store = require('./store');
const { WsUnixClient } = require('./ws-unix-client');
const { createLogger } = require('./logger');
const { undecidedIdentityKeys } = require('./launch-identity');
const {
  SAFE_PATH, ENGINE_BINARY, PLAIN_ARGUMENT, _shellWord, _launchesCodex, _readArguments, judgeRecordedCommand
} = require('./recorded-launch-command');

const log = createLogger('startup-control-codex');

/** The adapter's registered name; a profile's `adapter` field names it. */
const NAME = 'codex';

/** Where per-launch sockets are requested, under the store's base path. */
const RUN_DIRNAME = path.join('run', 'startup-control');

/** How long a launch waits for the app-server's socket to appear. */
const SOCKET_WAIT_MS = 5000;

/** How long one protocol request may take before it counts as unanswered. */
const CALL_TIMEOUT_MS = 15000;

/** How long `turn/start` may take to answer before the send is indeterminate. */
const TURN_START_TIMEOUT_MS = 30000;

/** How long the version probe may run. */
const VERSION_PROBE_TIMEOUT_MS = 5000;

/**
 * How long an executable that did not answer the launch's version probe is
 * left unasked. The probe is synchronous, so each ask of a Codex that hangs
 * stops the whole server for the probe's limit; a burst of launches, Master
 * ensures and summon retries would otherwise pay that once each. Short on
 * purpose: a remembered non-answer refuses launches, so a passing fault has
 * to clear by itself.
 */
const PROBE_UNANSWERED_MEMORY_MS = 60 * 1000;

/** Codex versions directly verified to accept `--no-daemon`. */
const NO_DAEMON_VERSIONS = Object.freeze(['0.156.1', '0.157.1']);

/** How often the reaper looks for channels whose session has ended. */
const REAP_INTERVAL_MS = 5 * 60 * 1000;

/** Reconnect attempts while watching an accepted fire, and the pause between them. */
const WATCH_RECONNECTS = 5;
const WATCH_RECONNECT_PAUSE_MS = 2000;

/**
 * How often an accepted fire re-reads the engine's turn record while it
 * waits for the turn to end. Measured live (2026-09-24, codex-cli 0.156.1):
 * `thread/resume` on a freshly materialized thread can fail with
 * `list_turns is not supported yet`, so a subscription is not guaranteed and
 * the record is the evidence that always answers.
 */
const WATCH_POLL_MS = 5000;

/** How long a thread must stay idle before an absent turn means "never sent": one instantaneous absence is not proof. */
const STABLE_IDLE_MS = 1500;

/** Most turn pages a reconcile reads before calling the thread unreadable. */
const MAX_TURN_PAGES = 200;

/** The client TangleClaw announces itself as. */
const CLIENT_INFO = Object.freeze({ name: 'tangleclaw', title: 'TangleClaw', version: _tangleclawVersion() });

/**
 * Every effect this module has on the machine, behind one object so a test
 * can replace them all and so no test can start a real app-server, signal a
 * real process or run a real `codex --version` by accident. Production uses
 * the real implementations.
 * @type {object}
 */
const _seams = {
  spawn,
  execFile,
  execFileSync,
  /**
   * The command line of a process, or '' when it cannot be read.
   * @param {number} pid - Process id.
   * @returns {string}
   */
  psCommand: (pid) => _ps(pid, 'command='),
  /**
   * The birth identity of a process (its start time as `ps` prints it), or ''.
   * @param {number} pid - Process id.
   * @returns {string}
   */
  psBirth: (pid) => _ps(pid, 'lstart=').trim(),
  kill: (pid, signal) => process.kill(pid, signal),
  resolveSocket: (requested) => _resolveSocket(requested),
  sleep: (ms) => _sleepSync(ms),
  ClientClass: WsUnixClient,
  now: () => Date.now(),
  realpathSync: (file) => fs.realpathSync(file),
  statSync: (file) => fs.statSync(file),
  /**
   * An engine's wake profile as the wake monitor compiled it, or undefined.
   * Required here and not at the top: the wake module reaches this adapter
   * through the startup-control facade.
   * @param {string} engineId - Engine id.
   * @returns {object|undefined}
   */
  wakeProfile: (engineId) => require('./medusa-wake').ENGINE_WAKE_PROFILES[engineId]
};

/**
 * One `ps` column for a pid.
 * @param {number} pid - Process id.
 * @param {string} column - A `ps -o` spec.
 * @returns {string}
 */
function _ps(pid, column) {
  try {
    return execFileSync('ps', ['-o', column, '-p', String(pid)], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

/**
 * TangleClaw's own version, for `initialize`'s clientInfo.
 * @returns {string}
 */
function _tangleclawVersion() {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'version.json'), 'utf8')).version || '0.0.0');
  } catch {
    return '0.0.0';
  }
}

/**
 * SHA-256 of a string, hex.
 * @param {string} text - Input.
 * @returns {string}
 */
function _sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The cached installed version. `installedVersion()` reads it and never
 * spawns; the probes fill it. A failed probe EMPTIES it: a stale value is
 * never reused.
 * @type {{version: (string|null), enginePath: (string|null), probedAt: (string|null), error: (string|null)}}
 */
const _version = { version: null, enginePath: null, probedAt: null, error: null };

/**
 * Executables that did not answer the launch's version probe, by resolved
 * path: the file each was when it was asked, and until when it is left
 * unasked. In this process only; a restart forgets it. Only a non-answer is
 * ever kept here. A version that was read is asked for again at every launch.
 * @type {Map<string, {stamp: string, askedAt: number, until: number}>}
 */
const _unanswered = new Map();

/**
 * Which file an executable path is right now: its resolved path and a stamp
 * of the file there. Null when that cannot be read, and for a bare command
 * name, which names a different file on a different PATH. A null identity is
 * never remembered, so such an executable is asked every time.
 * @param {string} bin - The executable a probe would run.
 * @returns {{path: string, stamp: string}|null}
 */
function _executableIdentity(bin) {
  if (typeof bin !== 'string' || !path.isAbsolute(bin)) return null;
  try {
    const real = _seams.realpathSync(bin);
    const st = _seams.statSync(real);
    return { path: real, stamp: [st.mtimeMs, st.size, st.ino, st.dev].join(':') };
  } catch {
    return null;
  }
}

/**
 * How long until an executable that did not answer is asked again, or null
 * when it may be asked now: nothing is remembered for it, the time has
 * passed, or the file at that path is no longer the one that was asked.
 * @param {{path: string, stamp: string}|null} identity - From `_executableIdentity`.
 * @param {number} now - Epoch milliseconds.
 * @returns {{sinceMs: number, retryInMs: number}|null}
 */
function _stillUnanswered(identity, now) {
  if (!identity) return null;
  const kept = _unanswered.get(identity.path);
  if (!kept) return null;
  if (kept.stamp !== identity.stamp || now >= kept.until || now < kept.askedAt) {
    _unanswered.delete(identity.path);
    return null;
  }
  return { sinceMs: now - kept.askedAt, retryInMs: kept.until - now };
}

/**
 * Parse `codex --version` output.
 * @param {string} text - Command output.
 * @returns {string|null}
 */
function _parseVersion(text) {
  const m = /codex-cli\s+(\d+\.\d+\.\d+)/.exec(String(text || ''));
  return m ? m[1] : null;
}

/**
 * Whether this exact Codex version was directly verified to accept
 * `--no-daemon`. Unknown, future and non-canonical versions are not treated as
 * accepting it, and `judgeLaunchCommand` refuses to launch them; compatibility
 * is never inferred from ordering.
 * @param {string|null} version - `MAJOR.MINOR.PATCH` from the version probe.
 * @returns {boolean}
 */
function _supportsNoDaemon(version) {
  return typeof version === 'string' && NO_DAEMON_VERSIONS.includes(version);
}

/**
 * The installed codex-cli version, from the last probe. Synchronous and
 * cached: this runs on request paths (`tc capabilities`, the fire route).
 * @returns {string|null}
 */
function installedVersion() {
  return _version.version;
}

/**
 * Why a Codex launch mode cannot reach the TangleClaw API from inside a turn,
 * read from the engine profile's own declaration — never re-derived here, so
 * this agrees with whatever `data/engines/codex.json#launchModes` says (#1836).
 * Every `tc` verb is loopback HTTP; `workspace-write` (the `fullAuto` mode)
 * denies outbound network, loopback included, unless Codex's own config opts
 * back in, which is a real sandbox policy, not a TangleClaw outage.
 * @param {object|null} engineProfile - An engine profile, e.g. `resolveProfile('codex')`
 * @param {string|null|undefined} launchMode - The session's launch mode key
 * @returns {{code: string, reason: string, remedy: string}|null} The declared
 *   cause and remedy, or `null` when this mode carries no such declaration
 */
function loopbackSandboxNote(engineProfile, launchMode) {
  const modes = engineProfile && engineProfile.launchModes;
  const mode = typeof launchMode === 'string' && modes ? modes[launchMode] : null;
  if (!mode || mode.sandboxBlocksLoopback !== true) return null;
  return {
    code: 'CODEX_SANDBOX_BLOCKS_LOOPBACK',
    reason: typeof mode.sandboxNote === 'string' ? mode.sandboxNote : 'This launch mode sandboxes outbound network, loopback included.',
    remedy: typeof mode.sandboxRemedy === 'string' ? mode.sandboxRemedy : 'Launch in a different mode, or adjust the sandbox network policy.'
  };
}

/**
 * Build the legacy launch command that keeps this launch off Codex's shared
 * background process: the exact executable that was probed, the launch's own
 * arguments, then `--no-daemon`. A command is built only for a version
 * directly verified to accept the flag; otherwise `command` is null and the
 * probe travels back so the judgment can say why.
 *
 * The probe is this launch's own and is returned: the one the launch already
 * made of this executable when it hands one on, else one taken here.
 * `judgeLaunchCommand` is handed that result and never reads the module's
 * version cache, which other probes (another launch, a request-path refresh,
 * another executable) also write.
 * @param {object} input
 * @param {string} input.engineId - Engine id.
 * @param {string} input.launchCmd - The command `_buildLaunchCommand` produced.
 * @param {string|null} input.shell - The profile's launch command name, which `launchCmd` starts with.
 * @param {string|null} input.enginePath - The exact executable this launch runs.
 * @param {string|null} [input.identifiedAs] - The engine the launch site recognised this launch as.
 * @param {object|null} [input.probe] - The probe this launch already made, reused when it is of this same executable.
 * @param {object} [deps] - Seam: `probeVersionSync`.
 * @returns {{applies: false} | {applies: true, command: (string|null), probe: {version: (string|null), enginePath: (string|null), retryInSeconds?: number}}}
 */
function isolateLaunch(input, deps = {}) {
  const { engineId, launchCmd, shell, enginePath, identifiedAs } = input || {};
  if (!_launchesCodex({ engineId, enginePath, command: launchCmd, identifiedAs })) return { applies: false };
  const word = _shellWord(enginePath);
  // An executable that is not named `codex` is not probed and gets no command:
  // its `--version` answer says what it prints, not that it passes the
  // isolation flag on to a Codex. `judgeLaunchCommand` refuses it by name.
  if (!word || path.basename(enginePath) !== ENGINE_BINARY) return { applies: true, command: null, probe: { version: null, enginePath: enginePath || null } };
  const probe = _launchProbe(input.probe, enginePath, deps);
  const version = probe.version;
  const startsWithShell = typeof shell === 'string' && shell !== '' && typeof launchCmd === 'string'
    && (launchCmd === shell || launchCmd.startsWith(`${shell} `));
  if (!startsWithShell || !_supportsNoDaemon(version)) return { applies: true, command: null, probe };
  const rest = launchCmd.slice(shell.length);
  const flagged = /(^|\s)--no-daemon(?=\s|$)/.test(rest) ? rest : `${rest} --no-daemon`;
  return { applies: true, command: `${word}${flagged}`, probe };
}

/**
 * The Codex version the install hint names: verified for the native channel and for `--no-daemon`.
 * Named, not taken from a position in `NO_DAEMON_VERSIONS`: appending or reordering that list
 * must never change what TangleClaw tells people to install.
 */
const RECOMMENDED_VERSION = '0.156.1';

/** The command that installs the recommended version. `data/engines/codex.json` offers the same one at first run. */
const INSTALL_COMMAND = `npm install -g @openai/codex@${RECOMMENDED_VERSION}`;

/** The Codex versions on which the update-check setting was measured to stop the startup update prompt being drawn. */
const UPDATE_PROMPT_MEASURED_ON = Object.freeze(['0.156.1', '0.157.1']);

/**
 * How to stay on a version a refusal has just told someone to install, or
 * nothing when any version it names was not measured. A verified Codex that
 * knows of a newer release opens on a prompt whose default choice installs the
 * newest one, which puts the operator back at the refusal. The sentence is
 * about that prompt only: an update made with no prompt was never observed, so
 * none is claimed, and a version the setting was not measured on gets no
 * advice rather than advice that may not hold there.
 * It names only the versions the remedy names: a remedy must not mention a
 * version its own path would refuse.
 * @param {string[]} versions - The versions the remedy names.
 * @returns {string}
 */
function _updatePromptAdvice(versions) {
  if (versions.length === 0 || !versions.every((v) => UPDATE_PROMPT_MEASURED_ON.includes(v))) return '';
  return ' Once it is installed, Codex may open on an update prompt whose default choice (Enter) runs `npm install -g @openai/codex`, '
    + 'which installs the newest Codex rather than a verified one. Setting `check_for_update_on_startup = false` in Codex\'s `config.toml` '
    + '(`~/.codex/config.toml` unless `CODEX_HOME` is set) stops that prompt being drawn '
    + `(measured on Codex ${versions.join(' and ')}). TangleClaw does not edit that file.`;
}

/**
 * The refusals an operator's launch-isolation override may set aside: the two
 * that mean this Codex version cannot be shown to stay off the shared
 * background process. Every other refusal is about what would run (a wrapper,
 * a path that cannot be named, arguments that cannot be read, a server this
 * launch did not start), and no override covers those.
 */
const OVERRIDABLE_REFUSALS = Object.freeze(['version_unknown', 'version_unverified']);

/** What a version refusal says about the override. One sentence: the refusal is read on a short-lived notice. */
const OVERRIDE_ADVICE = ' An operator can instead allow this launch without isolation, with the launch-isolation override.';

/**
 * What an operator can do about a refusal. Each reason has its own remedy: a
 * different Codex version fixes only the two version reasons, and telling
 * someone already on a verified version to install it sends them nowhere.
 * A remedy that names versions to install also says how to keep Codex on one,
 * where that was measured on each of them; the one that names none does not,
 * since staying on a version fixes nothing there. The two version reasons
 * also name the override, the only remedy that needs no other Codex version.
 * @param {string} reasonCode - Closed code.
 * @param {string[]|null} [nativeVerifiedVersions] - The versions verified for the native channel, for a refusal on that path.
 * @returns {string}
 */
function _recoveryFor(reasonCode, nativeVerifiedVersions) {
  const tail = ' Nothing was started. Sessions that were already running are not changed by this.';
  if (reasonCode === 'native_version_unverified') {
    // Only the versions verified for attaching are named. A version verified
    // for `--no-daemon` alone would be refused again on this same path.
    const verified = Array.isArray(nativeVerifiedVersions) ? nativeVerifiedVersions.filter((v) => typeof v === 'string') : [];
    return verified.length > 0
      ? `Install a Codex version TangleClaw has verified for this (${verified.join(' or ')}) with \`npm install -g @openai/codex@${verified[0]}\`, then launch again.${_updatePromptAdvice(verified)}${tail}`
      : `This TangleClaw records no Codex version as verified for attaching a session to its own server, so no Codex version fixes this: restore or update TangleClaw, then launch again.${tail}`;
  }
  if (reasonCode === 'version_unknown' || reasonCode === 'version_unverified') {
    return `Install a Codex version TangleClaw has verified (${NO_DAEMON_VERSIONS.join(' or ')}), for example with \`${INSTALL_COMMAND}\`, then launch again.${OVERRIDE_ADVICE}${_updatePromptAdvice(NO_DAEMON_VERSIONS)}${tail}`;
  }
  if (reasonCode === 'executable_unverified') {
    return `Select or install the real Codex executable and point the engine at it directly, then launch again. Changing the wrapper's version or flags does not help.${tail}`;
  }
  if (reasonCode === 'executable_unresolved') {
    return `Install Codex where its path holds no quote or control character and \`command -v codex\` finds it, then launch again.${tail}`;
  }
  return `This is the launch's configuration, not the Codex version: remove custom arguments from the Codex engine profile or launch mode, then launch again.${tail}`;
}

/**
 * Why this executable may not be run as Codex, or null when it may. Read from
 * the path alone: it runs nothing, so it can be asked before any process the
 * launch would start, a version probe included.
 * @param {string|null} enginePath - The executable the launch resolved.
 * @returns {{applies: true, allowed: false, reasonCode: string, reason: string, recovery: string}|null}
 */
function _executableRefusal(enginePath) {
  if (!_shellWord(enginePath)) {
    return _refuseLaunch('executable_unresolved', 'TangleClaw could not name the exact Codex executable this launch would run '
      + `(${enginePath ? 'its path cannot be placed in a command safely' : 'no path was resolved'}), so it cannot verify what would start.`);
  }
  if (path.basename(enginePath) !== ENGINE_BINARY) {
    return _refuseLaunch('executable_unverified', `This launch is configured as Codex, but the executable it would run is ${enginePath}, which is not named \`codex\`. `
      + 'TangleClaw cannot tell that a wrapper passes the isolation flags on, whatever version it reports.');
  }
  return null;
}

/**
 * Decide, before anything is run, whether a launch's executable may be run as
 * Codex at all. The launch site asks this ahead of the version probe and the
 * native channel's app-server, both of which execute the path: an executable
 * refused here is never started, so "nothing was started" is true of it.
 * `judgeLaunchCommand` applies the same test again to the final command.
 * @param {object} input
 * @param {string} input.engineId - Engine id.
 * @param {string|null} input.enginePath - The executable the launch resolved.
 * @param {string} [input.command] - The launch command as first built.
 * @param {string|null} [input.identifiedAs] - The engine the launch site recognised this launch as.
 * @returns {{applies: false} | {applies: true, allowed: true} | {applies: true, allowed: false, reasonCode: string, reason: string, recovery: string}}
 */
function admitExecutable(input) {
  const { engineId, enginePath, command, identifiedAs } = input || {};
  if (!_launchesCodex({ engineId, enginePath, command, identifiedAs })) return { applies: false };
  return _executableRefusal(enginePath) || { applies: true, allowed: true };
}

/**
 * A refusal, with the sentence an operator reads and what to do next.
 * @param {string} reasonCode - Closed code.
 * @param {string} reason - What was found.
 * @param {string[]|null} [nativeVerifiedVersions] - The versions verified for the native channel, for a refusal on that path.
 * @returns {{applies: true, allowed: false, reasonCode: string, reason: string, recovery: string, overridable: boolean}}
 *   `overridable` is true only for a reason in {@link OVERRIDABLE_REFUSALS}.
 */
function _refuseLaunch(reasonCode, reason, nativeVerifiedVersions) {
  return {
    applies: true, allowed: false, reasonCode, reason,
    recovery: _recoveryFor(reasonCode, nativeVerifiedVersions),
    overridable: OVERRIDABLE_REFUSALS.includes(reasonCode)
  };
}

/**
 * Judge the command a launch is about to run, and allow it only when it is
 * positively kept off Codex's shared background process.
 *
 * Why this exists: a Codex started bare can be served by a background process
 * another launch started, and tools run there carry THAT launch's TangleClaw
 * project and launch id. The process then acts as a different project.
 *
 * Two commands are allowed, and nothing else:
 * - the exact probed executable attached with `--remote` to the socket of the
 *   app-server this same launch started from that same executable, on a
 *   version the profile records as verified for that channel;
 * - the exact probed executable with `--no-daemon`, on a version directly
 *   verified to accept it.
 *
 * Pure: it spawns nothing and reads no cache. It reads the command as a
 * string, so it holds whichever code built that string, including a builder
 * that failed and fell back.
 *
 * A launch identified as Codex whose executable is not named `codex` is
 * refused: a wrapper is not trusted to pass the flags on.
 *
 * What it cannot see: an executable replaced between the probe and the pane's
 * exec; a wrapper or alias that nothing identifies as Codex; a different
 * program that is itself named `codex` (the name and the version it prints
 * are the whole identity tested); Codex reached over SSH; and
 * whether a `--remote` client can ever consult the shared process (allowed on
 * the evidence recorded for the native channel's verified version).
 * @param {object} input
 * @param {string} input.engineId - Engine id.
 * @param {string} input.command - The engine command, before any wrapper is prefixed.
 * @param {string|null} input.enginePath - The exact executable this launch resolved.
 * @param {{version: (string|null), enginePath: (string|null), retryInSeconds?: number}|null} [input.probe] - This launch's own
 *   version probe. `retryInSeconds` says the executable was not run, because it gave no answer a moment ago.
 * @param {{resolvedSocketPath: string, enginePath: string, engineVersion: string}|null} [input.native] - The app-server this launch started, if any.
 * @param {string[]|null} [input.nativeVerifiedVersions] - The versions the engine profile records as verified for the native channel.
 * @param {string|null} [input.identifiedAs] - The engine the launch site recognised this launch as.
 * @returns {{applies: false} | {applies: true, allowed: true, isolation: ('native-app-server'|'no-daemon')} | {applies: true, allowed: false, reasonCode: string, reason: string, recovery: string}}
 */
function judgeLaunchCommand(input) {
  const { engineId, enginePath, probe, native, nativeVerifiedVersions, identifiedAs } = input || {};
  const command = input && typeof input.command === 'string' ? input.command.trim() : '';
  if (!_launchesCodex({ engineId, enginePath, command, identifiedAs })) return { applies: false };
  const unfit = _executableRefusal(enginePath);
  if (unfit) return unfit;
  const word = _shellWord(enginePath);
  // A launch that attaches to a server answers for that server; any other
  // launch answers for its version first, because an unverified version is
  // why no isolated command could be built, and it is what the operator can fix.
  const attaches = /(^|\s)--remote(?=\s|$)/.test(command);
  const version = probe && probe.enginePath === enginePath ? probe.version : null;
  if (!attaches && !version) {
    const cannotTell = 'it cannot tell whether that Codex can be kept off its shared background process.';
    const wait = probe && probe.enginePath === enginePath && Number.isFinite(probe.retryInSeconds) ? probe.retryInSeconds : null;
    return _refuseLaunch('version_unknown', wait === null
      ? `TangleClaw could not read the version of ${enginePath}, so ${cannotTell}`
      : `TangleClaw asked ${enginePath} for its version less than a minute ago and got no answer, so this launch did not ask again and ${cannotTell} `
        + `It will be asked again in about ${wait} second${wait === 1 ? '' : 's'}, or at once if that file is replaced.`);
  }
  if (!attaches && !_supportsNoDaemon(version)) {
    return _refuseLaunch('version_unverified', `${enginePath} is Codex ${version}, which TangleClaw has not verified can be kept off Codex's shared background process. `
      + 'A shared background process can give one session another project\'s TangleClaw identity.');
  }
  const read = _readArguments(command, word, enginePath);
  if (read.refusal) return _refuseLaunch(read.refusal.reasonCode, read.refusal.reason);
  const words = read.words;
  if (attaches) {
    const bound = native && typeof native.resolvedSocketPath === 'string' && native.resolvedSocketPath !== ''
      && native.enginePath === enginePath
      && words[0] === '--remote' && words[1] === `unix://${native.resolvedSocketPath}`;
    if (!bound) {
      return _refuseLaunch('command_unisolated', 'The launch command attaches Codex to a server that this launch did not start from the checked executable.');
    }
    // The server must be one whose protocol was verified, as its own record
    // says: a socket and a path prove whose server it is, not that attaching
    // to that version keeps the session on it.
    const verified = Array.isArray(nativeVerifiedVersions) ? nativeVerifiedVersions : [];
    if (typeof native.engineVersion !== 'string' || !verified.includes(native.engineVersion)) {
      return _refuseLaunch('native_version_unverified', `The server this launch started is Codex ${native.engineVersion || '(version unknown)'}, which is not a version TangleClaw has verified for attaching a session to its own server.`, verified);
    }
    return { applies: true, allowed: true, isolation: 'native-app-server' };
  }
  if (!words.includes('--no-daemon')) {
    return _refuseLaunch('command_unisolated', `The launch command for Codex ${version} does not carry \`--no-daemon\`, so it would use Codex's shared background process.`);
  }
  return { applies: true, allowed: true, isolation: 'no-daemon' };
}

/**
 * Build and judge the command for a launch the operator's override allows
 * although its Codex version could not be shown isolated.
 *
 * The override sets aside the version refusal and nothing else, so everything
 * else {@link judgeLaunchCommand} tests is tested again here on the command
 * that would run: the executable, that the command opens with it, and that
 * its arguments can be read. A version refusal is answered first there, so it
 * can hide one of these; a refusal from here is not overridable.
 *
 * The command is the exact executable that was probed, then the launch's own
 * arguments. `--no-daemon` is never added: nothing shows this version accepts
 * it. A command that attaches to a server is refused: the override allows a
 * launch that may share Codex's background process, never one pointed at a
 * server this launch did not start. A command that already carries
 * `--no-daemon` among its own arguments is refused too: started, its recorded
 * command would be the one {@link judgeRecordedCommand} reads as isolated, on
 * a version nothing shows honours the flag.
 *
 * Pure: it runs nothing and reads no cache.
 * @param {object} input
 * @param {string} input.engineId - Engine id.
 * @param {string} input.launchCmd - The command `_buildLaunchCommand` produced.
 * @param {string|null} input.shell - The profile's launch command name, which `launchCmd` starts with.
 * @param {string|null} input.enginePath - The exact executable this launch resolved.
 * @param {{version: (string|null), enginePath: (string|null)}|null} [input.probe] - This launch's own version probe.
 * @param {string|null} [input.identifiedAs] - The engine the launch site recognised this launch as.
 * @returns {{applies: false} | {applies: true, allowed: true, command: string, versionRead: (string|null)} | {applies: true, allowed: false, reasonCode: string, reason: string, recovery: string, overridable: false}}
 */
function judgeOverriddenLaunch(input) {
  const { engineId, launchCmd, shell, enginePath, probe, identifiedAs } = input || {};
  if (!_launchesCodex({ engineId, enginePath, command: launchCmd, identifiedAs })) return { applies: false };
  const unfit = _executableRefusal(enginePath);
  if (unfit) return unfit;
  const word = _shellWord(enginePath);
  const startsWithShell = typeof shell === 'string' && shell !== '' && typeof launchCmd === 'string'
    && (launchCmd === shell || launchCmd.startsWith(`${shell} `));
  if (!startsWithShell) {
    return _refuseLaunch('command_not_pinned', 'The launch command does not start with the Codex command its engine profile names, '
      + `so TangleClaw cannot run it on the executable that was checked (${enginePath}).`);
  }
  const command = `${word}${launchCmd.slice(shell.length)}`.trim();
  const read = _readArguments(command, word, enginePath);
  if (read.refusal) return _refuseLaunch(read.refusal.reasonCode, read.refusal.reason);
  if (read.words.includes('--remote')) {
    return _refuseLaunch('command_unisolated', 'The launch command attaches Codex to a server that this launch did not start from the checked executable.');
  }
  if (read.words.includes('--no-daemon')) {
    return _refuseLaunch('command_unisolated', 'The launch\'s own arguments carry `--no-daemon`, and TangleClaw has not verified that this Codex version honours it, '
      + 'so the session would be recorded as isolated when nothing shows it is.');
  }
  const versionRead = probe && probe.enginePath === enginePath && typeof probe.version === 'string' && probe.version !== '' ? probe.version : null;
  return { applies: true, allowed: true, command, versionRead };
}

/**
 * This launch's probe of an executable. One launch reaches the probe from
 * more than one place (the capability read, the app-server start, the legacy
 * command), and the probe stops the server while it runs, so the first
 * answer of a launch is handed on and used here. A probe of any other path
 * is not this executable's answer and is not used.
 * @param {object|null|undefined} given - The probe the launch already made, if it handed one on.
 * @param {string|null|undefined} enginePath - The executable this launch runs.
 * @param {object} deps - Seam: `probeVersionSync`.
 * @returns {{version: (string|null), enginePath: (string|null), retryInSeconds?: number}}
 */
function _launchProbe(given, enginePath, deps) {
  if (enginePath && given && typeof given === 'object' && given.enginePath === enginePath) {
    const version = typeof given.version === 'string' && given.version !== '' ? given.version : null;
    return Number.isFinite(given.retryInSeconds) ? { version, enginePath, retryInSeconds: given.retryInSeconds } : { version, enginePath };
  }
  if (deps.probeVersionSync) return { version: deps.probeVersionSync({ enginePath }), enginePath: enginePath || null };
  return probeForLaunch({ enginePath });
}

/**
 * Probe the engine's version without blocking, and cache the answer.
 * @param {object} [deps] - Seams: `execFile`, `enginePath`.
 * @returns {Promise<string|null>}
 */
function probeVersion(deps = {}) {
  const run = deps.execFile || _seams.execFile;
  const bin = deps.enginePath || _version.enginePath || 'codex';
  return new Promise((resolve) => {
    run(bin, ['--version'], { timeout: VERSION_PROBE_TIMEOUT_MS }, (err, stdout) => {
      _recordProbe(err, stdout, bin);
      resolve(_version.version);
    });
  });
}

/**
 * Probe the exact engine executable a launch will run, synchronously and
 * bounded, and cache the answer. Used on the launch path only, which is
 * an operator action that already spawns.
 * @param {object} [deps] - Seams: `execFileSync`, `enginePath`.
 * @returns {string|null}
 */
function probeVersionSync(deps = {}) {
  return probeForLaunch(deps).version;
}

/**
 * The launch's version probe, with what a caller needs to hand it on: the
 * executable asked and, when it was not asked because it gave no answer a
 * moment ago, how long until it will be.
 *
 * An executable that fails, times out or prints something that is not a
 * version is left unasked for `PROBE_UNANSWERED_MEMORY_MS`, as long as the
 * file at its path stays the same file. Replacing it asks again at once. An
 * executable whose file cannot be read is never remembered.
 * @param {object} [deps] - Seams: `execFileSync`, `enginePath`.
 * @returns {{version: (string|null), enginePath: (string|null), retryInSeconds?: number}} `retryInSeconds` is present
 *   only when this call did not run the executable.
 */
function probeForLaunch(deps = {}) {
  const run = deps.execFileSync || _seams.execFileSync;
  const bin = deps.enginePath || 'codex';
  const enginePath = deps.enginePath || null;
  const identity = _executableIdentity(bin);
  const waiting = _stillUnanswered(identity, _seams.now());
  if (waiting) {
    const retryInSeconds = Math.max(1, Math.ceil(waiting.retryInMs / 1000));
    _recordUnasked(bin, Math.round(waiting.sinceMs / 1000), retryInSeconds);
    return { version: null, enginePath, retryInSeconds };
  }
  try {
    const out = run(bin, ['--version'], { timeout: VERSION_PROBE_TIMEOUT_MS, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    _recordProbe(null, out, bin);
  } catch (err) {
    _recordProbe(err, '', bin);
  }
  if (identity) {
    if (_version.version) {
      _unanswered.delete(identity.path);
    } else {
      const askedAt = _seams.now();
      _unanswered.set(identity.path, { stamp: identity.stamp, askedAt, until: askedAt + PROBE_UNANSWERED_MEMORY_MS });
    }
  }
  return { version: _version.version, enginePath };
}

/**
 * Record that an executable was not asked, because it gave no answer a
 * moment ago. The cached version is emptied exactly as a failed probe
 * empties it.
 * @param {string} bin - The executable that was not run.
 * @param {number} sinceSeconds - How long ago it failed to answer.
 * @param {number} retryInSeconds - How long until it is asked again.
 * @returns {void}
 */
function _recordUnasked(bin, sinceSeconds, retryInSeconds) {
  _version.probedAt = new Date().toISOString();
  _version.enginePath = bin;
  _version.version = null;
  _version.error = `not asked: no answer ${sinceSeconds}s ago, asked again in ${retryInSeconds}s`;
  log.warn('codex --version not run: this executable gave no answer a moment ago. It is asked again when the wait ends or the file is replaced', { bin, sinceSeconds, retryInSeconds });
}

/**
 * Record a probe's result.
 * @param {Error|null} err - Probe error.
 * @param {string} stdout - Probe output.
 * @param {string} bin - The executable probed.
 * @returns {void}
 */
function _recordProbe(err, stdout, bin) {
  _version.probedAt = new Date().toISOString();
  _version.enginePath = bin;
  if (err) {
    _version.version = null;
    _version.error = err.message;
    log.warn('codex --version failed; the startupControl channel resolves to unsupported', { bin, error: err.message });
    return;
  }
  _version.version = _parseVersion(stdout);
  _version.error = _version.version ? null : `unrecognised output: ${String(stdout).trim().slice(0, 80)}`;
  if (!_version.version) log.warn('codex --version output not understood', { bin, output: String(stdout).trim().slice(0, 80) });
}

/**
 * Synchronous sleep without a busy loop.
 * @param {number} ms - Milliseconds.
 * @returns {void}
 */
function _sleepSync(ms) {
  spawnSync('sleep', [String(ms / 1000)], { timeout: ms + 1000 });
}

/**
 * The directory sockets are requested in, created on first use.
 * @returns {string}
 */
function _runDir() {
  const dir = path.join(store._getBasePath(), RUN_DIRNAME);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Resolve the socket Codex actually bound. `--listen unix://<long path>`
 * binds a short path under `/private/tmp/codex-daemon-<uid>/` and leaves a
 * symlink at the requested one; the TUI must be handed the short path.
 * @param {string} requested - The requested socket path.
 * @returns {string|null} The bound path, or null when nothing is there yet.
 */
function _resolveSocket(requested) {
  try {
    const st = fs.lstatSync(requested);
    if (st.isSymbolicLink()) {
      const target = fs.readlinkSync(requested);
      const resolved = path.isAbsolute(target) ? target : path.join(path.dirname(requested), target);
      return fs.existsSync(resolved) ? resolved : null;
    }
    return st.isSocket() ? requested : null;
  } catch {
    return null;
  }
}

/**
 * The canonical identity of a directory: its real path when it exists, else
 * its resolved form. Two spellings of one directory compare equal.
 * @param {string} p - A path.
 * @returns {string}
 */
function _canonicalDir(p) {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return path.resolve(p);
  }
}

/** The variables that say which tmux pane a process runs in. */
const TMUX_PANE_KEYS = Object.freeze(['TMUX', 'TMUX_PANE']);

/**
 * The environment the per-launch app-server runs with: TangleClaw's own, the
 * pane's entries over it, and nothing that names a tmux pane. The app-server
 * runs in no pane. Left in, a TangleClaw server that was itself started from a
 * pane would hand its own pane to every tool the engine runs, and `tc` there
 * would compare this launch's identity with that other pane's and refuse.
 *
 * Nor does it carry a launch identity variable the pane's entries give no
 * value for. Such a value could only be TangleClaw's own: a TangleClaw server
 * started from inside a launched pane holds that pane's role or workspace id,
 * and every tool the engine runs here would present it as this launch's.
 * @param {Object<string, string>} own - TangleClaw's environment.
 * @param {Object<string, string>} [paneEnv] - The pane's environment entries.
 * @returns {Object<string, string>}
 */
function _serverEnvironment(own, paneEnv) {
  const given = paneEnv && typeof paneEnv === 'object' ? paneEnv : {};
  const env = { ...own, ...given };
  for (const key of TMUX_PANE_KEYS) delete env[key];
  for (const key of undecidedIdentityKeys(given)) delete env[key];
  return env;
}

/**
 * Start the per-launch app-server and build the pane's command.
 *
 * Synchronous, because `launchSession` is. A failure here does not by itself
 * fail the launch: the caller records the reason as `channel_unavailable` and
 * falls back to the legacy command, which `judgeLaunchCommand` must then allow.
 *
 * @param {object} input
 * @param {object} input.project - The project (its `path` is the thread's cwd).
 * @param {object} input.engineProfile - The resolved engine profile.
 * @param {string} input.launchCmd - The command `_buildLaunchCommand` produced (already validated argv).
 * @param {string|null} [input.enginePath] - The exact engine executable this launch runs.
 * @param {object|null} [input.probe] - The probe this launch already made, reused when it is of this same executable.
 * @param {Object<string, string>} [input.env] - The pane's environment entries. The server gets them layered over
 *   TangleClaw's own, because with `--remote` the agent loop and its shell tools run here, not in the pane, and
 *   a `tc` the fired prompt asks the engine to run needs the same PATH floor and launch identity the pane has.
 * @param {object} [deps] - Seams.
 * @returns {{ok: true, handle: object, command: string} | {ok: false, reasonCode: string, reason: string}}
 */
function prepareLaunch(input, deps = {}) {
  const spawnFn = deps.spawn || _seams.spawn;
  const resolveSocket = deps.resolveSocket || _seams.resolveSocket;
  const sleep = deps.sleep || _seams.sleep;
  const unavailable = (reason) => ({ ok: false, reasonCode: 'channel_unavailable', reason });
  const version = _launchProbe(input.probe, input.enginePath || undefined, deps).version;
  if (!version) return unavailable('the engine version could not be probed for this launch');
  const shell = input.engineProfile && input.engineProfile.launch ? input.engineProfile.launch.shellCommand : null;
  if (!shell || typeof input.launchCmd !== 'string' || !(input.launchCmd === shell || input.launchCmd.startsWith(`${shell} `))) {
    return unavailable('the launch command does not start with the engine binary, so --remote cannot be placed');
  }
  let requested;
  try {
    requested = path.join(_runDir(), `${crypto.randomBytes(8).toString('hex')}.sock`);
  } catch (err) {
    return unavailable(`no run directory for the socket: ${err.message}`);
  }
  const bin = input.enginePath || shell;
  let child;
  try {
    child = spawnFn(bin, ['app-server', '--listen', `unix://${requested}`], {
      cwd: input.project.path,
      detached: true,
      stdio: 'ignore',
      env: _serverEnvironment(process.env, input.env)
    });
    child.unref();
  } catch (err) {
    return unavailable(`could not start the app-server: ${err.message}`);
  }
  if (!child || !child.pid) return unavailable('the app-server did not start');
  const birth = (deps.psBirth || _seams.psBirth)(child.pid);
  let resolved = null;
  const deadline = (deps.now || _seams.now)() + SOCKET_WAIT_MS;
  while (!resolved && (deps.now || _seams.now)() < deadline) {
    resolved = resolveSocket(requested);
    if (!resolved) sleep(100);
  }
  const state = { pid: child.pid, birth, socketPath: requested, resolvedSocketPath: resolved, engineVersion: version, enginePath: bin, threadId: null, serverVersion: null };
  if (!resolved) {
    _terminate(state, deps);
    return unavailable(`the app-server did not open its socket within ${SOCKET_WAIT_MS}ms`);
  }
  if (!SAFE_PATH.test(resolved)) {
    _terminate(state, deps);
    return unavailable('the resolved socket path contains characters that cannot be placed in the pane command');
  }
  const rest = input.launchCmd.slice(shell.length);
  // The pane runs the same executable the app-server was started from, by
  // path. The command's name alone would be resolved again by the pane's
  // shell, on a PATH its rc files rebuild, and could be a different Codex.
  // A path that cannot be one shell word keeps the name; `judgeLaunchCommand`
  // then refuses the launch instead of running something unchecked.
  const command = `${_shellWord(bin) || shell} --remote unix://${resolved}${rest}`;
  log.info('startupControl channel started for a launch', { project: input.project.name, pid: child.pid });
  return { ok: true, handle: { state, command }, command };
}

/**
 * Record a started channel against the session it now belongs to.
 * @param {object} handle - From `prepareLaunch`.
 * @param {{sessionId: number, sequenceId: number, engineId: string}} launch - The bound launch.
 * @returns {object|null} The channel row, or null when it could not be recorded (the channel is then stopped).
 */
function attachLaunch(handle, launch) {
  try {
    return store.startupControlChannels.open({
      sessionId: launch.sessionId,
      sequenceId: launch.sequenceId,
      engineId: launch.engineId,
      adapter: NAME,
      adapterState: handle.state
    });
  } catch (err) {
    log.warn('Could not record the startupControl channel; stopping it', { session: launch.sessionId, error: err.message });
    abandonLaunch(handle, 'channel row not recorded');
    return null;
  }
}

/**
 * Stop a channel that never got a session.
 * @param {object} handle - From `prepareLaunch`.
 * @param {string} reason - Why.
 * @returns {void}
 */
function abandonLaunch(handle, reason) {
  log.info('startupControl channel abandoned', { pid: handle.state.pid, reason });
  _terminate(handle.state);
}

/**
 * Whether `state` still names the app-server this adapter started: the same
 * command line (app-server on this socket) AND the same birth identity, so a
 * pid reused by an unrelated process is never ours.
 * @param {object} state - Adapter state.
 * @param {object} [deps] - Seams: `psCommand`, `psBirth`.
 * @returns {boolean}
 */
function _isOurAppServer(state, deps = {}) {
  if (!state || !Number.isInteger(state.pid) || state.pid <= 0) return false;
  const command = (deps.psCommand || _seams.psCommand)(state.pid);
  if (!command.includes('app-server') || !command.includes(state.socketPath)) return false;
  if (state.birth) {
    const birth = (deps.psBirth || _seams.psBirth)(state.pid);
    if (birth !== state.birth) return false;
  }
  return true;
}

/**
 * Terminate an app-server we started (its whole process group, since it was
 * spawned detached as a group leader), and remove its socket link. Never
 * signals a pid that is not ours, and reports what it did.
 * @param {object} state - Adapter state.
 * @param {object} [deps] - Seams.
 * @returns {{signalled: boolean, teardown: string}} `teardown` is 'ok', 'skipped' or the error.
 */
function _terminate(state, deps = {}) {
  let result = { signalled: false, teardown: 'skipped' };
  if (_isOurAppServer(state, deps)) {
    const kill = deps.kill || _seams.kill;
    try {
      try {
        kill(-state.pid, 'SIGTERM');
      } catch (groupErr) {
        if (groupErr.code === 'ESRCH') throw groupErr;
        kill(state.pid, 'SIGTERM');
      }
      result = { signalled: true, teardown: 'ok' };
    } catch (err) {
      result = err.code === 'ESRCH'
        ? { signalled: false, teardown: 'skipped' }
        : { signalled: false, teardown: `signal failed: ${err.message}` };
      if (err.code !== 'ESRCH') log.warn('Could not signal the app-server', { pid: state.pid, error: err.message });
    }
  }
  if (state && state.socketPath) {
    try { fs.unlinkSync(state.socketPath); } catch { /* already gone */ }
  }
  return result;
}

/**
 * End the channel of a session that has ended (killed, wrapped to an end,
 * crashed, or replaced by a new launch). Idempotent; a session with no
 * channel is a no-op.
 * @param {number} sessionId - Session id.
 * @param {string} reason - Why.
 * @param {object} [deps] - Seams.
 * @returns {object|null} The closed channel row, if there was one.
 */
function releaseSession(sessionId, reason, deps = {}) {
  let channel;
  try {
    channel = store.startupControlChannels.getOpenBySession(sessionId);
  } catch (err) {
    log.warn('Could not read the session\'s startupControl channel', { session: sessionId, error: err.message });
    return null;
  }
  if (!channel || channel.adapter !== NAME) return null;
  const result = _terminate(channel.adapterState, deps);
  const closed = store.startupControlChannels.close(channel.id, reason, result.teardown);
  log.info('startupControl channel closed', { session: sessionId, channel: channel.id, reason, teardown: result.teardown });
  return closed;
}

/**
 * Close every open channel whose session is no longer active. Runs at boot
 * (after recovery) and on an interval.
 * @param {object} [deps] - Seams.
 * @returns {{examined: number, closed: number}}
 */
function reap(deps = {}) {
  let examined = 0;
  let closed = 0;
  let channels;
  try {
    channels = store.startupControlChannels.listOpen();
  } catch (err) {
    log.warn('startupControl reaper could not list channels', { error: err.message });
    return { examined, closed };
  }
  for (const channel of channels) {
    if (channel.adapter !== NAME) continue;
    examined += 1;
    let session = null;
    try {
      session = store.sessions.get(channel.sessionId);
    } catch (err) {
      // Unknown is not ended: a read that failed says nothing about the pane,
      // and signalling its server on that basis could sever a live session.
      log.warn('startupControl reaper could not read a channel\'s session; leaving it', { channel: channel.id, error: err.message });
      continue;
    }
    if (session && session.status === store.SESSION_STATUS.ACTIVE) continue;
    const result = _terminate(channel.adapterState, deps);
    store.startupControlChannels.close(channel.id, session ? `session ${session.status}` : 'session row missing', result.teardown);
    closed += 1;
  }
  if (closed > 0) log.info('startupControl reaper closed channels of ended sessions', { closed });
  return { examined, closed };
}

/**
 * After a TangleClaw restart: revalidate every open channel of an active
 * session (its server must answer and report the version the channel was
 * recorded with), then recover every in-flight fire without resending: a
 * resend could deliver the prompt twice. A channel that does not answer is closed as lost; its fires are
 * settled as far as the evidence allows and otherwise left indeterminate.
 * @param {object} [deps] - Seams.
 * @returns {Promise<{channels: number, lost: number, fires: number}>}
 */
async function recover(deps = {}) {
  const out = { channels: 0, lost: 0, fires: 0 };
  const applyTransition = deps.applyTransition || _storeTransition;
  let channels = [];
  let fires = [];
  try {
    // Both snapshots are taken before the first await: a fire that begins
    // while the channels are being revalidated belongs to the running server,
    // not to the restart, and must never be judged here.
    channels = store.startupControlChannels.listOpen().filter((c) => c.adapter === NAME);
    fires = store.startupPrompts.listActiveFires();
  } catch (err) {
    log.warn('startupControl recovery could not list channels or fires', { error: err.message });
    return out;
  }
  const live = new Map();
  for (const channel of channels) {
    let session = null;
    try { session = store.sessions.get(channel.sessionId); } catch { session = null; }
    if (!session || session.status !== store.SESSION_STATUS.ACTIVE) continue;
    out.channels += 1;
    const opened = await _connect(channel, deps);
    if (opened.blocker) {
      out.lost += 1;
      const result = _terminate(channel.adapterState, deps);
      store.startupControlChannels.close(channel.id, `not answering after restart: ${opened.blocker.reason}`, result.teardown);
      continue;
    }
    const serverVersion = _serverVersion(opened.conn.initResult);
    opened.conn.close();
    if (channel.adapterState.serverVersion && serverVersion !== channel.adapterState.serverVersion) {
      out.lost += 1;
      const result = _terminate(channel.adapterState, deps);
      store.startupControlChannels.close(channel.id, `server version changed after restart (${serverVersion})`, result.teardown);
      continue;
    }
    live.set(channel.sessionId, channel);
  }
  for (const fire of fires) {
    let session = null;
    try { session = store.sessions.get(fire.sessionId); } catch { session = null; }
    if (!session || session.engineId !== NAME) continue;
    out.fires += 1;
    const onUpdate = (patch) => applyTransition(fire.id, patch);
    if (fire.outcome === 'pending' && !fire.dispatchedAt) {
      onUpdate({ outcome: 'failed', reasonCode: 'restart_before_dispatch', reason: 'TangleClaw restarted before this fire was dispatched; nothing was sent, and it may be fired again' });
      continue;
    }
    if (fire.outcome === 'pending' || fire.outcome === 'dispatching') {
      onUpdate({ outcome: 'indeterminate', reasonCode: 'send_unconfirmed', reason: 'TangleClaw restarted after the send began and before the engine answered; never retried automatically' });
    }
    if (!live.has(fire.sessionId)) {
      onUpdate({ outcome: 'indeterminate', reasonCode: 'channel_lost', reason: 'the channel did not survive the restart, so the turn cannot be followed; relaunch the session' });
      continue;
    }
    const current = store.startupPrompts.getFireById(fire.id);
    try {
      if (current.outcome === 'accepted') {
        _resumeWatch({ session, fire: current, onUpdate }, deps);
      } else {
        await reconcile({ session, fire: current, onUpdate }, deps);
      }
    } catch (err) {
      log.warn('Could not recover a fire after restart', { fire: fire.id, error: err.message });
    }
  }
  return out;
}

let _reapTimer = null;

/**
 * Apply a fire transition straight to the store. The fallback for a caller
 * that supplies no `applyTransition`; the server supplies the service's, so
 * every transition is also logged to the activity log by one writer.
 * @param {number} fireId - Fire row id.
 * @param {object} patch - Transition.
 * @returns {object} The row.
 */
function _storeTransition(fireId, patch) {
  const r = store.startupPrompts.updateFire(fireId, patch);
  return r.fire || store.startupPrompts.getFireById(fireId);
}

/**
 * Boot: probe the version, recover channels and fires, then start the reaper.
 * @param {object} [opts]
 * @param {(fireId: number, patch: object) => object} [opts.applyTransition] - The one writer of fire transitions.
 * @returns {Promise<void>}
 */
async function start(opts = {}) {
  await probeVersion().catch(() => null);
  try { await recover({ applyTransition: opts.applyTransition }); } catch (err) { log.warn('startupControl recovery failed at boot', { error: err.message }); }
  try { reap(); } catch (err) { log.warn('startupControl reaper failed at boot', { error: err.message }); }
  if (!_reapTimer) {
    _reapTimer = setInterval(() => {
      try { reap(); } catch (err) { log.warn('startupControl reaper failed', { error: err.message }); }
    }, REAP_INTERVAL_MS);
    _reapTimer.unref();
  }
}

/**
 * Stop the reaper (tests and shutdown).
 * @returns {void}
 */
function stop() {
  if (_reapTimer) clearInterval(_reapTimer);
  _reapTimer = null;
}

/**
 * One connection to an app-server: the JSON-RPC layer over the WebSocket.
 * Requests get numeric ids and time out; notifications and server requests
 * are emitted as `notification` (`{method, params}`) and `serverRequest`.
 * Server requests (approvals, user input) are never answered by TangleClaw.
 */
class AppServerConnection extends EventEmitter {
  /**
   * @param {string} socketPath - The resolved socket.
   * @param {object} [deps] - Seams: `ClientClass`.
   */
  constructor(socketPath, deps = {}) {
    super();
    this.socketPath = socketPath;
    const ClientClass = deps.ClientClass || _seams.ClientClass;
    this.client = new ClientClass(socketPath);
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.client.on('message', (text) => this._onMessage(text));
    this.client.on('close', (info) => this._onClose(info));
    // A socket error or protocol fault is handled HERE: logged, remembered, and
    // turned into a close (the client destroys itself on a fault; a plain
    // socket error is destroyed here). It is re-emitted only to a listener that
    // asked for it, because an 'error' event with no listener throws out of the
    // socket handler and would leave a watcher polling a dead socket forever.
    this.client.on('error', (err) => this._fault(err));
  }

  /**
   * Record a socket or protocol fault, tell a listener that asked, and drop
   * the connection so its `closed` event drives the recovery.
   * @param {Error} err - The fault.
   * @returns {void}
   */
  _fault(err) {
    this.lastError = err;
    log.warn('app-server connection fault', { socket: this.socketPath, error: err.message });
    if (this.listenerCount('error') > 0) this.emit('error', err);
    if (!this.closed) this.client.destroy();
  }

  /**
   * Dial and run the initialize handshake.
   * @returns {Promise<object>} The `initialize` result.
   */
  async open() {
    await this.client.connect();
    const result = await this.call('initialize', { clientInfo: CLIENT_INFO });
    this.notify('initialized', {});
    return result;
  }

  /**
   * Send a request and await its result.
   * @param {string} method - Method name.
   * @param {object} params - Params.
   * @param {number} [timeoutMs=CALL_TIMEOUT_MS] - Deadline.
   * @returns {Promise<object>} The result; rejects with `{code, message}` on an error response.
   */
  call(method, params, timeoutMs = CALL_TIMEOUT_MS) {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(Object.assign(new Error('connection closed'), { code: 'CLOSED' }));
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Object.assign(new Error(`${method} unanswered after ${timeoutMs}ms`), { code: 'TIMEOUT' }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.client.send(JSON.stringify({ id, method, params }));
      } catch (err) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(Object.assign(err, { code: err.code || 'CLOSED' }));
      }
    });
  }

  /**
   * Send a notification.
   * @param {string} method - Method name.
   * @param {object} params - Params.
   * @returns {void}
   */
  notify(method, params) {
    this.client.send(JSON.stringify({ method, params }));
  }

  /**
   * Route one inbound message.
   * @param {string} text - JSON text.
   * @returns {void}
   */
  _onMessage(text) {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      this._fault(new Error('app-server sent a message that is not JSON'));
      return;
    }
    if (msg && msg.id !== undefined && msg.method === undefined) {
      const entry = this.pending.get(msg.id);
      if (!entry) return;
      this.pending.delete(msg.id);
      clearTimeout(entry.timer);
      if (msg.error) {
        entry.reject(Object.assign(new Error(msg.error.message || 'app-server error'), { code: msg.error.code, data: msg.error.data }));
      } else {
        entry.resolve(msg.result);
      }
      return;
    }
    if (msg && msg.method && msg.id !== undefined) {
      this.emit('serverRequest', { id: msg.id, method: msg.method, params: msg.params });
      return;
    }
    if (msg && msg.method) this.emit('notification', { method: msg.method, params: msg.params });
  }

  /**
   * Fail every pending request when the socket goes.
   * @param {object} info - Close info.
   * @returns {void}
   */
  _onClose(info) {
    this.closed = true;
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(Object.assign(new Error(`connection closed before ${entry.method} answered`), { code: 'CLOSED' }));
      this.pending.delete(id);
    }
    this.emit('closed', info);
  }

  /**
   * Close the connection.
   * @returns {void}
   */
  close() {
    this.closed = true;
    this.client.close();
  }
}

/**
 * The version an `initialize` result reports, from its userAgent.
 * @param {object} init - The result.
 * @returns {string|null}
 */
function _serverVersion(init) {
  const m = /^[^/]+\/(\d+\.\d+\.\d+)/.exec(String(init && init.userAgent ? init.userAgent : ''));
  return m ? m[1] : null;
}

/**
 * A blocker result.
 * @param {string} reasonCode - Bounded code.
 * @param {string} reason - Human-readable.
 * @returns {{ready: false, reasonCode: string, reason: string}}
 */
function _blocked(reasonCode, reason) {
  return { ready: false, reasonCode, reason };
}

/**
 * What Codex's config says about trusting the project directory: `'trusted'`,
 * `'untrusted'` when it holds an entry that is anything else, `'absent'` when
 * it holds no entry for the folder, or `null` when the answer cannot be read
 * at all.
 *
 * An entry that says something other than trusted is a decision somebody
 * recorded, and is not the same as no entry: only `'absent'` may be put to the
 * trust exception.
 *
 * `projects: null` is a well-formed answer: a home that has never trusted any
 * folder reports exactly that, so it means "no entry", the same as a table
 * without this folder. A `projects` key that is missing, or holds something
 * that is not a table, is an answer this code does not understand, and that
 * stays unknown.
 * @param {object} config - The `config/read` result.
 * @param {string} projectPath - The project path.
 * @returns {'trusted'|'untrusted'|'absent'|null}
 */
function _trusted(config, projectPath) {
  const inner = config && config.config;
  if (!inner || typeof inner !== 'object' || Array.isArray(inner) || !('projects' in inner)) return null;
  const projects = inner.projects;
  if (projects === null) return 'absent';
  if (typeof projects !== 'object' || Array.isArray(projects)) return null;
  const want = _canonicalDir(projectPath);
  for (const [key, value] of Object.entries(projects)) {
    if (_canonicalDir(key) === want) return value && value.trust_level === 'trusted' ? 'trusted' : 'untrusted';
  }
  return 'absent';
}

/** The id Codex's profile gives its folder-trust dialog (`launch.guardedDialogs`). */
const TRUST_DIALOG_ID = 'folder-trust';

/** Longest dispatch note and longest reason a fire row stores; the store enforces both. */
const DISPATCH_NOTE_MAX = store.STARTUP_FIRE_DISPATCH_NOTE_MAX;
const REASON_MAX = 500;

/**
 * The two patterns that say the Codex TUI is still starting: any header row
 * that names its model, and that row while it holds the value shown before a
 * thread exists. They are declared once, in the engine profile's wake block
 * (`headerPattern`, `startingPattern`), where the wake's pane gate reads them
 * too, so the fire's witness and the wake cannot come to mean different things
 * by "starting". The profile asked for is the one of the launch's own engine
 * id, which is the profile the wake reads for that session: an engine profile
 * under another id may name this adapter.
 * @param {string} engineId - The engine id the launch's channel records.
 * @param {object} [known] - That engine's wake profile, where the caller has
 *   already read it for this same look, so one look reads one profile.
 * @returns {{headerRe: RegExp, startingRe: RegExp}|null} Null when that
 *   profile declares none, which the caller must treat as a pane it cannot
 *   check: the witness asks nothing of a header it is given no pattern for.
 */
function _startingPatterns(engineId, known) {
  const profile = known === undefined ? _seams.wakeProfile(engineId) : known;
  if (!profile || !(profile.headerRe instanceof RegExp) || !(profile.startingRe instanceof RegExp)) return null;
  return { headerRe: profile.headerRe, startingRe: profile.startingRe };
}

/**
 * Codex's status row, drawn below its composer: its status line, indented two
 * columns, its items joined by a middle dot (`GPT-6-Astra default · <cwd>`, or
 * the operator's own layout). On a version with no declared footer it is the
 * only row allowed there, and anything else is not a composer at rest. A
 * status line configured down to a single item has no separator and is
 * refused by this pattern; that fails closed, and is the price of not guessing
 * what a row with no shape is. `_statusRowPattern` adds the one single item
 * that can be checked, on a version that declares a footer.
 */
const STATUS_RE = /^ {2}[^\s│╭╰╮╯›>].* · \S/;

/**
 * A token that names a key a dialog footer offers. Codex's dialog footers have
 * the status row's shape (`  enter continue · esc skip`) and are told from it
 * by these names: the keys that confirm, dismiss or move a selection. A status
 * row can name a key too, and is still a status row: Codex 0.156.1 appends
 * `⚠ 1 warning · f2 to view` to it in a folder that holds its own `.codex/`
 * config, at an empty composer. So function keys are not on this list, and
 * adding them would refuse every session showing a Codex warning. Whole tokens
 * only, and no bare direction words: the measured status row reads
 * `Context 100% left`.
 */
const KEY_HINT_RE = /^(enter|return|esc|escape|tab|space|arrows?|[↑↓←→]+)$/i;

/**
 * How an operator grants Codex trust for a folder when no dialog offers it.
 * The folder is not repeated here: a fire's reason is stored in 500
 * characters, the sentence before this one already names it, and this is the
 * sentence that must not be the one cut off.
 * @type {string}
 */
const HOW_TO_TRUST = 'To grant trust, add this folder under [projects] in Codex\'s config.toml with trust_level = "trusted", or run codex once in it outside TangleClaw and accept its prompt; then Fire again.';

/**
 * What a fire or a launch gate says when the engine profile in force gives the
 * witness no way to tell a screen that is still starting. A configuration
 * fault: waiting does not clear it, and it is neither a pane seen unready nor
 * a proof that could not be made.
 * @param {string} engineId - The engine id the launch's channel records.
 * @returns {string}
 */
function _noStartingPatterns(engineId) {
  return `The engine profile in force for this session (${engineId}) declares no capabilities.wake.headerPattern and startingPattern, so the pane could not be checked for a screen that is still starting and nothing was sent. This does not clear by itself: restore those two fields in that profile, then Fire again.`;
}

/**
 * The exact Codex version a channel is proved to be on: the one its launch
 * recorded and the one its app-server reports, when they are the same. Null
 * when either is missing or they differ. Deliberately not the installed
 * binary's: that says what the host would start next, not what this launch is.
 * @param {AppServerConnection} conn - The opened connection (`initResult`).
 * @param {object} channel - The channel row.
 * @returns {{version: string|null, recorded: string|null, reported: string|null}}
 */
function _provedVersion(conn, channel) {
  const state = (channel && channel.adapterState) || {};
  const recorded = typeof state.engineVersion === 'string' && state.engineVersion !== '' ? state.engineVersion : null;
  const reported = _serverVersion(conn && conn.initResult);
  return { version: recorded !== null && recorded === reported ? recorded : null, recorded, reported };
}

/**
 * What the channel's version draws below its composer at rest, as the engine
 * profile declares it per exact version (`capabilities.wake.restRows`).
 *
 * Three answers. `unproved`: the version could not be proved, so no rule can
 * be chosen for it. A proved version with `footerRe`: it draws its status row
 * and then that one footer row, and its launch thread is identified by its own
 * metadata (see `_threadKind`). A proved version with `footerRe: null`: the
 * profile declares nothing for it, and it keeps the one-row rule, under which
 * any screen that does draw a footer is refused.
 *
 * Never inferred across versions: the table is asked for this version's own
 * entry and for nothing else.
 * @param {AppServerConnection} conn - The opened connection.
 * @param {object} channel - The channel row (`engineId`, `adapterState.engineVersion`).
 * @returns {{version: string, footerRe: RegExp|null, profile: (object|null)} | {unproved: true, recorded: string|null, reported: string|null}}
 *   `profile` is the wake profile the answer was read from, or null when the engine has none.
 */
function _restScreen(conn, channel) {
  const proved = _provedVersion(conn, channel);
  if (proved.version === null) return { unproved: true, recorded: proved.recorded, reported: proved.reported };
  const profile = _seams.wakeProfile(channel.engineId) || null;
  const table = profile && profile.restRows;
  const entry = table && Object.prototype.hasOwnProperty.call(table, proved.version) ? table[proved.version] : null;
  return { version: proved.version, footerRe: entry && entry.footerRe instanceof RegExp ? entry.footerRe : null, profile };
}

/**
 * The status row of a version that declares a footer: today's shape (items
 * joined by a middle dot), or a status line configured down to one item where
 * that item is positively known. The one item the protocol itself states is
 * the thread's model, so the row may be exactly that model, alone, compared
 * without case (`  GPT-6.1-Sol` for `gpt-6.1-sol`). Any other single item (a
 * folder, a thread name) has nothing to be checked against and stays refused,
 * as does a model that could not be read as one plain token.
 * @param {*} model - The launch thread's model as `thread/read` reported it.
 * @returns {RegExp}
 */
function _statusRowPattern(model) {
  if (typeof model !== 'string' || !/^\S{1,80}$/.test(model)) return STATUS_RE;
  const literal = model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${STATUS_RE.source}|^ {2}${literal}$`, 'i');
}

/**
 * The pane half of `_paneAndThread`: does the pane this launch created
 * positively show an empty ordinary composer? Kept apart only so the launch
 * gate can ask it of a launch whose thread has not opened yet, to say which
 * dialog is holding it; nothing is ever sent on this half alone.
 * @param {object} a - `witness, launchPaneId, launchPaneServer, engineId, projectPath, single, rest, model`, as `_paneAndThread`.
 * @returns {Promise<{proven: true} | {proven: false, at: string, unavailable: boolean, why?: string, dialog?: object, lasting?: boolean, recorded?: (string|null), reported?: (string|null)}>}
 */
async function _paneProof({ witness, launchPaneId, launchPaneServer, engineId, projectPath, single = false, rest = null, model = null }) {
  if (typeof witness !== 'function') return { proven: false, at: 'no-witness', unavailable: true };
  // The pane a launch created is recorded on its channel when it starts. A
  // channel with none (it predates the record, or the record failed) has no
  // pane this can be sure is the launch's: a session's pane can be replaced.
  if (typeof launchPaneId !== 'string' || launchPaneId === '' || typeof launchPaneServer !== 'string' || launchPaneServer === '') {
    return { proven: false, at: 'no-pane-record', unavailable: true, lasting: true };
  }
  // Which rows may follow the composer is a fact of the exact version, so a
  // channel whose version is not proved has no rule to be read by. Waiting
  // does not prove it.
  if (rest && rest.unproved === true) {
    return { proven: false, at: 'version-unproved', unavailable: true, lasting: true, recorded: rest.recorded, reported: rest.reported };
  }
  const starting = rest && 'profile' in rest ? _startingPatterns(engineId, rest.profile) : _startingPatterns(engineId);
  if (!starting) {
    log.warn('The engine profile in force declares no starting header pattern; the pane is not consulted', { project: projectPath, engineId });
    return { proven: false, at: 'no-starting-patterns', unavailable: false, lasting: true };
  }
  // One status row, or for a version that declares a footer, one status row
  // and then that footer. Never a count of two: the order is the rule.
  const below = rest && rest.footerRe
    ? { statusRe: _statusRowPattern(model), footerRe: rest.footerRe }
    : { statusRe: STATUS_RE, maxStatusRows: 1 };
  let seen;
  try {
    seen = await witness({
      headerRe: starting.headerRe, startingRe: starting.startingRe, ...below, keyHintRe: KEY_HINT_RE,
      paneId: launchPaneId, paneServer: launchPaneServer, ...(single ? { single: true } : {})
    });
  // prawduct:allow prawduct/broad-except -- a witness fault must settle as a proof that could not be made, never throw out of a fire or a launch
  } catch (err) {
    log.warn('The pane witness failed; nothing is sent on it', { project: projectPath, error: err.message });
    return { proven: false, at: 'witness-failed', unavailable: true };
  }
  if (!seen || seen.shown !== true) {
    if (seen && seen.dialog) return { proven: false, at: 'dialog', unavailable: false, dialog: seen.dialog };
    const lasting = !!seen && seen.lasting === true;
    return {
      proven: false,
      at: 'pane',
      // A pane that is not the launch's own was not read at all, and a read
      // the witness says failed proves nothing about what the pane shows.
      unavailable: lasting || (!!seen && seen.unavailable === true),
      why: seen && typeof seen.why === 'string' && seen.why ? seen.why : 'the pane did not show an empty composer',
      ...(lasting ? { lasting: true } : {})
    };
  }
  return { proven: true };
}

/**
 * The one check that the launch's pane positively shows an empty ordinary
 * composer AND its thread is idle after that was seen.
 *
 * Three callers stand on it, so none can come to mean something different by
 * "the pane is ready": the launch gate, a fire into a folder with no trust
 * entry, and the automatic fire's last look before it sends. The pane is
 * witnessed first and the thread read afterwards, because the witness takes
 * time and an idle answer older than the pane's is not the one to act on.
 *
 * It decides nothing about wording or reason codes. It says what it found, and
 * whether that was a pane SEEN not ready or a proof that could not be made;
 * each caller words its own refusal from that.
 *
 * @param {object} a
 * @param {AppServerConnection} a.conn - An open connection.
 * @param {string} a.threadId - The launch's thread.
 * @param {string} a.want - The canonical project directory.
 * @param {Function|undefined} a.witness - The pane witness the fire service supplies, `(opts) => Promise<{shown, dialog, why, lasting?, unavailable?}>`.
 * @param {string|null} a.launchPaneId - The pane this launch created, as its channel records it.
 * @param {string|null} a.launchPaneServer - The tmux server that pane was created in.
 * @param {string} a.engineId - The engine id the launch's channel records; its wake profile says what a starting header looks like.
 * @param {string} a.projectPath - The project path, for the log.
 * @param {boolean} [a.single=false] - One fresh pane read instead of two a second apart: for a caller that already has the two-read answer.
 * @param {object|null} [a.rest=null] - What the channel's version draws at rest (`_restScreen`). Absent, the
 *   one-row rule is used and no version is asked for.
 * @param {string|null} [a.model=null] - The thread's model as read BEFORE the pane, for a version that declares
 *   a footer: the one single-item status row that is recognised. The thread must still report it afterwards.
 * @param {object|null} [a.channel=null] - The launch's channel row. With it, on a version that declares a footer,
 *   what is read after the pane is the whole of `_launchThread`'s answer for the recorded thread (every loaded
 *   thread, the others' activity, the channel's generation), not that one thread alone.
 * @returns {Promise<{proven: true} | {proven: false, at: string, unavailable: boolean, why?: string, dialog?: object, lasting?: boolean, error?: string, status?: string}>}
 *   `at` is one of `no-witness`, `no-pane-record`, `version-unproved`, `no-starting-patterns`, `witness-failed`,
 *   `dialog`, `pane`, `threads`, `thread-unreadable`, `thread-changed`, `thread-status`.
 */
async function _paneAndThread({ conn, threadId, want, witness, launchPaneId, launchPaneServer, engineId, projectPath, single = false, rest = null, model = null, channel = null }) {
  const pane = await _paneProof({ witness, launchPaneId, launchPaneServer, engineId, projectPath, single, rest, model });
  if (pane.proven !== true) return pane;
  let t;
  if (rest && rest.footerRe && channel) {
    // On a version read by identity, reading the chosen thread again would not
    // show what else changed while the pane was being witnessed: a second
    // launch thread, the title helper starting to work, a thread that can no
    // longer be read, or a channel that is no longer this launch's. So the
    // whole question is asked again, of the thread now recorded.
    const found = await _launchThread(conn, { ...channel, adapterState: { ...(channel.adapterState || {}), threadId, provisionalThreadId: null } }, want, true);
    if (found.blocked) return { proven: false, at: 'threads', unavailable: found.unavailable === true, why: found.blocked.reason };
    t = found.thread;
  } else {
    let again;
    try {
      again = await conn.call('thread/read', { threadId, includeTurns: false });
    } catch (err) {
      log.warn('The launch\'s thread could not be read again after the pane was witnessed', { threadId, error: err.message });
      return { proven: false, at: 'thread-unreadable', unavailable: true, error: err.message };
    }
    t = again && again.thread;
  }
  if (!t || t.id !== threadId || typeof t.cwd !== 'string' || _canonicalDir(t.cwd) !== want) {
    return { proven: false, at: 'thread-changed', unavailable: false };
  }
  // The pane was read against the model the thread reported before it. A
  // thread that now reports another is not the one that row was checked for.
  if (rest && rest.footerRe && (typeof t.model === 'string' ? t.model : null) !== (typeof model === 'string' ? model : null)) {
    return { proven: false, at: 'thread-changed', unavailable: false };
  }
  const now = t.status && t.status.type;
  if (now !== 'idle') return { proven: false, at: 'thread-status', unavailable: false, status: now || 'unknown' };
  return { proven: true };
}

/**
 * What was read when a channel's Codex version could not be proved.
 * @param {{recorded?: (string|null), reported?: (string|null)}} found - The refusal.
 * @returns {string}
 */
function _versionUnproved(found) {
  return `this launch's Codex version could not be proved (the launch recorded ${found.recorded || 'none'}, its app-server reports ${found.reported || 'none'}), so which rows it draws below its composer at rest is not known`;
}

/** What an operator does about a launch whose automatic fire was held on the pane. */
const FIRE_BY_HAND = 'Press Fire startup prompt once the pane shows an empty composer.';

/** What an operator does when the pane on record is not one this launch can ever be shown ready on. */
const RELAUNCH = 'This does not clear by itself: relaunch the session.';

/**
 * A `_paneAndThread` refusal in the words the launch gate and the automatic
 * fire's send-time read both use: what was last observed, whether that is a
 * proof that could not be made, and what the operator does.
 * @param {object} found - A `_paneAndThread` answer with `proven: false`.
 * @param {string} engineId - The engine id the launch's channel records.
 * @returns {{unavailable: boolean, lasting: boolean, observation: string, remedy: string, whole?: string}}
 *   `whole` is set when the finding is a sentence of its own that neither lead-in fits (a profile fault).
 */
function _launchRefusal(found, engineId) {
  const say = (observation, remedy = FIRE_BY_HAND) => ({ unavailable: found.unavailable === true, lasting: found.lasting === true, observation, remedy });
  switch (found.at) {
    case 'no-witness': return say('this session\'s pane could not be consulted');
    case 'no-pane-record': return say('the pane this launch created was not recorded', RELAUNCH);
    case 'version-unproved': return say(_versionUnproved(found), RELAUNCH);
    case 'no-starting-patterns': return { ...say('the engine profile declares no starting header pattern', ''), whole: _noStartingPatterns(engineId) };
    case 'witness-failed': return say('the pane could not be checked for an empty composer');
    case 'dialog':
      return say(`Codex was showing its ${found.dialog.id} prompt in the pane (read from the pane)`,
        `${found.dialog.humanAction || 'TangleClaw does not answer it: answer it in the pane.'} Then press Fire startup prompt.`);
    case 'pane':
      return found.unavailable === true
        ? say(found.why, found.lasting === true ? RELAUNCH : FIRE_BY_HAND)
        : say(`the pane was not seen at an empty composer: ${found.why}`);
    case 'threads': return say(found.why);
    case 'thread-unreadable': return say('the launch\'s thread could not be read over the channel');
    case 'thread-changed': return say('the launch\'s thread was no longer the one in the project directory');
    default: return say(`the launch's thread was ${found.status || 'in an unknown state'}, not idle`);
  }
}

/**
 * Whether a bind must be this caller's own write. Where another writer has
 * already persisted the SAME thread, the conditional write answers
 * `written: false` with that thread on the row: this caller lost the write
 * and did not make the inference that row stands on, so it refuses and the
 * next look reads what the winner proved.
 * @param {{written?: boolean}|null|undefined} result - An `updateAdapterStateIf` answer.
 * @returns {boolean}
 */
function _wroteIt(result) {
  return !!result && result.written === true;
}

/**
 * Bind an unbound channel to its launch's own thread, on a version read by
 * identity, and prove the binding before anyone may act on it.
 *
 * The binding is an inference: "the only thread of the launch's kind loaded
 * for the folder". An inference is not a record until it has been checked, so
 * it is never written where a record goes. It is written to its own field,
 * `adapterState.provisionalThreadId`, and `adapterState.threadId` stays empty
 * until the proof: every reader of the recorded thread, in this module or any
 * other, sees a channel that is not yet bound. The steps:
 *
 * 1. the first list names exactly one launch thread, and no thread that
 *    cannot be read or identified;
 * 2. compare-and-set, on the launch's own open channel with no thread and no
 *    provisional thread on it: the provisional thread. A write that fails, or
 *    that this caller did not make, binds nothing here;
 * 3. the threads are listed and read AGAIN and must be the same threads with
 *    the same sole launch thread;
 * 4. a second conditional write, on that same provisional thread, moves it to
 *    `threadId` and clears the provisional field. Only then is it recorded.
 *
 * A check that fails after step 2 withdraws the inference by a guarded write
 * (only this thread, only while it is still the provisional one) and
 * refuses. Whether or not that write lands the refusal stands and nothing is
 * acted on: an inference that could not be withdrawn is still only
 * provisional, so the next look must prove it from step 1 (skipping only the
 * first write) or withdraw it.
 *
 * @param {object} a
 * @param {object} a.channel - The channel row as the look read it.
 * @param {() => Promise<{candidates: object[], unreadThreads: number} | {failed: string}>} a.list - One fresh
 *   read of the threads loaded for the project directory.
 * @param {{candidates: object[], unreadThreads: number}} a.first - The list the look has already made.
 * @returns {Promise<{thread: object, candidates: object[]} | {refused: string, n?: number, detail?: string}>}
 *   `refused` is one of `unread`, `list-failed`, `unidentified`, `none`, `title-only`, `several`,
 *   `bind-failed`, `bind-lost`, `changed`, `confirm-failed`.
 */
async function _proveLaunchThread({ channel, list, first }) {
  const state = channel.adapterState || {};
  const channels = store.startupControlChannels;
  const held = !state.threadId && typeof state.provisionalThreadId === 'string' && state.provisionalThreadId !== '' ? state.provisionalThreadId : null;
  const ours = (row) => row.state === 'open' && row.sequenceId === channel.sequenceId;
  /** Whether a row holds exactly this provisional thread and no recorded one. */
  const provisionalIs = (row, id) => !!row.adapterState && !row.adapterState.threadId && row.adapterState.provisionalThreadId === id;
  /**
   * Withdraw a provisional thread, if it is still that thread and still provisional.
   * @param {string} id - The thread.
   * @returns {void}
   */
  const withdraw = (id) => {
    try {
      const undone = channels.updateAdapterStateIf(channel.id,
        (row) => ours(row) && provisionalIs(row, id),
        { provisionalThreadId: null });
      if (!_wroteIt(undone)) log.warn('An unproved launch thread was not withdrawn; it stays provisional and is not acted on', { channel: channel.id });
    } catch (err) {
      log.warn('An unproved launch thread could not be withdrawn; it stays provisional and is not acted on', { channel: channel.id, error: err.message });
    }
  };
  /**
   * What one list says: the sole launch thread, or why there is none to name.
   * @param {{candidates: object[], unreadThreads: number}} seen - A list.
   * @returns {{thread: object} | {refused: string, n?: number}}
   */
  const sole = (seen) => {
    if (seen.unreadThreads > 0) return { refused: 'unread' };
    if (seen.candidates.some((t) => _threadKind(t) === 'unidentified')) return { refused: 'unidentified' };
    const own = seen.candidates.filter((t) => _threadKind(t) === 'launch');
    if (own.length === 0) return { refused: seen.candidates.length === 0 ? 'none' : 'title-only' };
    if (own.length > 1) return { refused: 'several', n: own.length };
    return { thread: own[0] };
  };

  const one = sole(first);
  if (one.refused) {
    if (held) withdraw(held);
    return one;
  }
  const candidate = one.thread.id;
  if (held && held !== candidate) {
    withdraw(held);
    return { refused: 'changed' };
  }
  if (!held) {
    let bound;
    try {
      bound = channels.updateAdapterStateIf(channel.id,
        (row) => ours(row) && !(row.adapterState && (row.adapterState.threadId || row.adapterState.provisionalThreadId)),
        { provisionalThreadId: candidate });
    } catch (err) {
      log.warn('Could not bind the channel thread for a launch', { channel: channel.id, error: err.message });
      return { refused: 'bind-failed' };
    }
    const persisted = bound && bound.channel && bound.channel.adapterState ? bound.channel.adapterState.provisionalThreadId : null;
    if (persisted !== candidate || !_wroteIt(bound)) return { refused: 'bind-lost' };
  }

  // "The only one" is established again AFTER the write, from a fresh list and
  // fresh reads, and must name the same thread among the same threads.
  // Reading the chosen thread again would not show a second launch thread, or
  // the title helper, that appeared in between.
  const before = first.candidates.map((t) => t.id).sort().join(' ');
  const again = await list();
  if (again.failed !== undefined) {
    withdraw(candidate);
    return { refused: 'list-failed', detail: again.failed };
  }
  const two = sole(again);
  if (two.refused || two.thread.id !== candidate || again.candidates.map((t) => t.id).sort().join(' ') !== before) {
    withdraw(candidate);
    return two.refused === 'unread' ? two : { refused: 'changed' };
  }

  let confirmed;
  try {
    confirmed = channels.updateAdapterStateIf(channel.id,
      (row) => ours(row) && provisionalIs(row, candidate),
      { threadId: candidate, provisionalThreadId: null });
  } catch (err) {
    log.warn('Could not record a proved launch thread; it stays provisional', { channel: channel.id, error: err.message });
    return { refused: 'confirm-failed' };
  }
  const row = confirmed && confirmed.channel && confirmed.channel.adapterState ? confirmed.channel.adapterState : null;
  if (!_wroteIt(confirmed) || !row || row.threadId !== candidate || row.provisionalThreadId) return { refused: 'confirm-failed' };
  return { thread: two.thread, candidates: again.candidates };
}

/**
 * The launch's own thread on an open connection: the recorded one when the
 * channel records one, else the sole thread loaded for the project directory,
 * which is then recorded. Never a guess between several.
 *
 * On a version that declares its rows at rest (`byIdentity`), "the sole
 * thread" is the sole thread positively identified as the launch's own
 * (`_threadKind`): those versions load a second, ephemeral thread in the same
 * folder to name the session, which is never the launch's and never bound,
 * even alone. There, a loaded thread that cannot be read or identified
 * refuses, and so does any other thread for the folder that is working or in
 * a status the protocol does not promise: the title helper is not ignored.
 * @param {AppServerConnection} conn - An opened connection.
 * @param {object} channel - The channel row.
 * @param {string} want - The canonical project directory.
 * @param {boolean} [byIdentity=false] - The channel's proved version declares its rows at rest.
 * @returns {Promise<{thread: object} | {blocked: {ready: false, reasonCode: string, reason: string}, unavailable: boolean}>}
 *   `unavailable` says the threads, or one of them, could not be read, as against all read and found wanting.
 *   The fire words its refusal from `blocked` alone; the launch gate also reads this.
 */
async function _launchThread(conn, channel, want, byIdentity = false) {
  const state = channel.adapterState || {};
  /**
   * One fresh read of every loaded thread, kept to those in the project directory.
   * @returns {Promise<{candidates: object[], unreadThreads: number} | {failed: string}>}
   */
  const list = async () => {
    let loaded;
    try {
      loaded = await conn.call('thread/loaded/list', {});
    } catch (err) {
      return { failed: err.message };
    }
    const found = [];
    let unread = 0;
    for (const id of (loaded && loaded.data) || []) {
      let read;
      try {
        read = await conn.call('thread/read', { threadId: id, includeTurns: false });
      } catch (err) {
        unread += 1;
        log.warn('A loaded thread could not be read while looking for the launch\'s own', { channel: channel.id, error: err.message });
        continue;
      }
      const t = read && read.thread;
      if (t && typeof t.cwd === 'string' && _canonicalDir(t.cwd) === want) found.push(t);
    }
    return { candidates: found, unreadThreads: unread };
  };
  const first = await list();
  if (first.failed !== undefined) {
    return { blocked: _blocked('readiness_unknown', `the loaded threads could not be listed: ${first.failed}`), unavailable: true };
  }
  let { candidates, unreadThreads } = first;
  // A thread that could not be read might have been the launch's, so "none
  // was found" is then a read that was not made, and is marked as one.
  const refuse = (reason) => ({ blocked: _blocked('engine_not_ready', reason), unavailable: unreadThreads > 0 });
  if (byIdentity) {
    const UNREAD = 'a loaded thread could not be read, so the launch\'s own thread could not be told from the others';
    let thread;
    if (state.threadId) {
      // An unreadable thread might be the title helper mid-turn or a second
      // session: the answers below cannot be given without it.
      if (unreadThreads > 0) return refuse(UNREAD);
      // The recorded thread is the launch's; filtering never replaces it.
      thread = candidates.find((t) => t.id === state.threadId) || null;
      if (!thread) return refuse(`the launch's recorded thread is not loaded for the project directory (${candidates.length} other candidate${candidates.length === 1 ? '' : 's'})`);
    } else {
      // No thread is recorded. There may be a provisional one, an inference
      // nobody has proved: either way the launch's thread is proved here or not used.
      const proved = await _proveLaunchThread({ channel, list, first: { candidates, unreadThreads } });
      if (proved.refused) {
        switch (proved.refused) {
          case 'unread': unreadThreads = Math.max(unreadThreads, 1); return refuse(UNREAD);
          case 'list-failed':
            return { blocked: _blocked('readiness_unknown', `the loaded threads could not be listed again after the launch's thread was bound: ${proved.detail}`), unavailable: true };
          case 'unidentified': return refuse('a thread loaded for the project directory could not be identified as this launch\'s own or as Codex\'s title helper; not firing at a guess');
          case 'none': return refuse('the pane has not opened a thread for the project directory yet: it may be starting, or showing a trust or login dialog');
          case 'title-only': return refuse('only Codex\'s title helper is loaded for the project directory, and it is never the launch\'s thread');
          case 'several': return refuse(`${proved.n} threads are loaded for the project directory and none is recorded as this launch's; not firing at a guess`);
          case 'bind-failed': return refuse('the launch\'s thread could not be recorded on its channel, so it is not bound and nothing is sent on it');
          case 'bind-lost': return refuse('the launch\'s channel was bound to another thread, or by another reader, or was replaced, while this one was being chosen; not firing at a guess');
          case 'changed': return refuse('the threads loaded for the project directory changed while the launch\'s thread was being bound, so it is not known to be the only one of its kind and is not bound');
          default: return refuse('the launch\'s thread was chosen but could not be recorded as proved, so it is not bound and nothing is sent on it');
        }
      }
      ({ thread, candidates } = proved);
    }
    const others = _othersActivity(candidates.filter((t) => t !== thread));
    if (others) {
      return refuse(others.state === 'busy'
        ? 'another thread loaded for the project directory is working, so nothing is sent beside it'
        : 'another thread loaded for the project directory is in a state the protocol does not promise, so it is not known to be at rest');
    }
    // The answer speaks for the channel generation it was read under: still
    // open, still this launch's, and still bound to the thread chosen.
    let now;
    try {
      now = store.startupControlChannels.get(channel.id);
    } catch (err) {
      log.warn('Could not read the channel again before answering for its thread', { channel: channel.id, error: err.message });
      now = null;
    }
    if (!now || now.state !== 'open' || now.sequenceId !== channel.sequenceId || !now.adapterState || now.adapterState.threadId !== thread.id || now.adapterState.provisionalThreadId) {
      return refuse('the launch\'s channel changed while its thread was being read, so the answer is not given for it');
    }
    return { thread };
  }
  if (state.threadId) {
    const thread = candidates.find((t) => t.id === state.threadId) || null;
    if (!thread) return refuse(`the launch's recorded thread is not loaded for the project directory (${candidates.length} other candidate${candidates.length === 1 ? '' : 's'})`);
    return { thread };
  }
  if (candidates.length === 1) {
    try { store.startupControlChannels.setAdapterState(channel.id, { threadId: candidates[0].id }); } catch (err) { log.warn('Could not record the channel thread', { error: err.message }); }
    return { thread: candidates[0] };
  }
  if (candidates.length === 0) {
    return refuse('the pane has not opened a thread for the project directory yet: it may be starting, or showing a trust or login dialog');
  }
  return refuse(`${candidates.length} threads are loaded for the project directory and none is recorded as this launch's; not firing at a guess`);
}

/** How long a launch waits for its pane to be proven ready, and how often it looks. */
const LAUNCH_READY_WINDOW_MS = 90_000;
const LAUNCH_READY_POLL_MS = 1500;

/**
 * One look at whether the launch may be given its first turn: its channel is
 * open and its own, its thread is idle, and `_paneAndThread` passes on two
 * pane reads a second apart.
 * @param {object} input - As `awaitLaunchReady`.
 * @param {object} deps - Seams.
 * @returns {Promise<{ready: true} | {ready: false, unavailable: boolean, lasting: boolean, observation: string, remedy: string, whole?: string}>}
 */
async function _launchLook(input, deps) {
  const { session, project, sequenceId, witness } = input;
  /**
   * A look that could not be made. The fault's own text goes to the log, not to the row an operator reads.
   * @param {string} observation - What could not be read, in the row's words.
   * @param {boolean} [lasting=false] - Whether waiting cannot clear it.
   * @param {string} [fault] - The underlying error or reason, for the log.
   * @returns {object}
   */
  const unread = (observation, lasting = false, fault) => {
    if (fault) log.warn('The launch gate could not make a read', { session: session.id, observation, error: fault });
    return { ready: false, unavailable: true, lasting, observation, remedy: lasting ? RELAUNCH : FIRE_BY_HAND };
  };
  const unready = (observation) => ({ ready: false, unavailable: false, lasting: false, observation, remedy: FIRE_BY_HAND });
  let channel;
  try {
    channel = store.startupControlChannels.getOpenBySession(session.id);
  } catch (err) {
    return unread('the channel record could not be read', false, err.message);
  }
  if (!channel || channel.adapter !== NAME) return unread('this session has no open native channel', true);
  if (Number.isInteger(sequenceId) && channel.sequenceId !== sequenceId) return unread('the session\'s channel belongs to a different launch', true);
  // A channel that records no socket has nothing to connect to, now or later.
  if (!(channel.adapterState && channel.adapterState.resolvedSocketPath)) return unread('the channel records no socket', true);
  const opened = await _connect(channel, deps);
  if (opened.blocker) return unread('the app-server did not answer', false, opened.blocker.reason);
  const conn = opened.conn;
  try {
    const want = _canonicalDir(project.path);
    const rest = _restScreen(conn, channel);
    const found = await _launchThread(conn, channel, want, !!rest.footerRe);
    const state = channel.adapterState || {};
    const pane = { witness, launchPaneId: state.paneId || null, launchPaneServer: state.paneServer || null, engineId: channel.engineId, projectPath: project.path, rest };
    // The pane half alone (`_paneProof`) takes no channel; the full check does.
    const full = { ...pane, channel };
    if (found.blocked) {
      if (found.unavailable) return unread('the loaded threads could not all be read over the channel', false, found.blocked.reason);
      // Codex opens no thread while a startup dialog is up. One read of the
      // pane says which, so the row names what the operator has to answer;
      // anything else it shows changes nothing, since there is no thread.
      const shown = await _paneProof({ ...pane, single: true });
      if (shown.proven !== true && shown.at === 'dialog') return { ready: false, ..._launchRefusal(shown, channel.engineId) };
      return unready(found.blocked.reason);
    }
    const status = found.thread.status && found.thread.status.type;
    if (status !== 'idle') return unready(`the launch's thread was ${status || 'in an unknown state'}, not idle`);
    const proof = await _paneAndThread({ conn, threadId: found.thread.id, want, ...full, model: found.thread.model });
    if (proof.proven === true) return { ready: true };
    return { ready: false, ..._launchRefusal(proof, channel.engineId) };
  } finally {
    conn.close();
  }
}

/**
 * Wait, inside the launch window, until this launch may be given its first
 * turn (#2059). The optional launch-readiness half of the adapter contract.
 *
 * Ready means both proofs at once: the launch's one thread is in the project
 * directory and idle, and the pane the launch created positively shows an
 * empty ordinary composer, on two reads a second apart, with the thread read
 * idle again after them. An idle thread alone never answers ready: the
 * protocol cannot see a dialog, typed text or a pane still being drawn.
 *
 * Nothing here reads Codex's status line for a word. That line is the
 * operator's to configure, and its default carries no at-rest item, so a
 * launch gated on one waits out the window on a pane that is ready.
 *
 * A ready answer is not permission to send. It says the pane BECAME ready; the
 * automatic fire looks once more immediately before its `turn/start`.
 *
 * @param {object} input
 * @param {object} input.session - The launched session (`id`).
 * @param {object} input.project - Its project (`path`).
 * @param {number} [input.sequenceId] - The launch the caller means; a channel of another launch is refused.
 * @param {Function|undefined} input.witness - The pane witness the fire service builds for this session.
 * @param {number} [input.windowMs] - How long to wait.
 * @param {number} [input.pollMs] - How long between looks.
 * @param {object} [deps] - Seams: `now`, `wait`, and the connection's.
 * @returns {Promise<{ready: true} | {ready: false, unavailable: boolean, observation: string, remedy: string, whole?: string}>}
 *   On `ready: false`, `observation` is the last thing actually read, and `unavailable` says the pane or the
 *   channel could not be read, as against read and found not ready.
 */
async function awaitLaunchReady(input, deps = {}) {
  const now = deps.now || _seams.now;
  const wait = deps.wait || ((ms) => new Promise((resolve) => { setTimeout(resolve, ms); }));
  const windowMs = Number.isInteger(input.windowMs) ? input.windowMs : LAUNCH_READY_WINDOW_MS;
  const pollMs = Number.isInteger(input.pollMs) ? input.pollMs : LAUNCH_READY_POLL_MS;
  const deadline = now() + windowMs;
  let last;
  for (;;) {
    last = await _launchLook(input, deps);
    if (last.ready === true) return { ready: true };
    // A refusal that waiting cannot clear is answered now, not at the window's end.
    if (last.lasting === true || now() + pollMs >= deadline) break;
    await wait(pollMs);
  }
  const { lasting, ...answer } = last;
  void lasting;
  return answer;
}

/**
 * Decide a fire whose every protocol check passed except the trust entry
 * (#2186).
 *
 * Codex's config holds no trust entry for the folder. On a version measured to
 * draw no trust dialog on this launch path, the fire may still go when a pane
 * witness positively sees an empty composer: the operator's own typing would
 * do the same thing there. A dialog that is actually on screen refuses it, and
 * so does anything short of positive evidence. Nothing here writes a trust
 * entry or types a key.
 *
 * The version list is a recorded fact of the engine profile, not of the
 * adapter: a version outside it keeps the block, and an empty list keeps the
 * block for every version.
 *
 * The pane is witnessed and the launch's thread then read idle once more, by
 * the one check the launch gate and the automatic fire's send-time read also
 * use (`_paneAndThread`): the witness takes about a second, and the send must
 * follow an idle answer, not one a second old.
 *
 * @param {object} a
 * @param {AppServerConnection} a.conn - The fire's open connection.
 * @param {string} a.threadId - The launch's thread, already read idle.
 * @param {string} a.want - The canonical project directory.
 * @param {string} a.projectPath - The project path.
 * @param {string} a.serverVersion - The version the app-server reported.
 * @param {{absentOn?: string[], witness?: Function}|undefined} a.exception - From the fire service: the
 *   measured versions and a pane witness `(opts) => Promise<{shown, dialog, why}>`.
 * @param {string|null} a.launchPaneId - The pane this launch created, as recorded on its channel when it
 *   started; the witness vouches for that pane only.
 * @param {string|null} a.launchPaneServer - The tmux server that pane was created in, recorded with it; a pane
 *   id means that pane only there.
 * @param {string} a.engineId - The engine id the launch's channel records; its wake profile says what a
 *   starting header looks like.
 * @param {object|null} [a.rest] - What the channel's version draws at rest (`_restScreen`).
 * @param {string|null} [a.model] - The launch thread's model, as just read.
 * @param {object|null} [a.channel] - The launch's channel row, for the read made after the pane.
 * @returns {Promise<{allowed: true, note: string} | {allowed: false, reasonCode: string, reason: string}>}
 */
async function _withoutTrustEntry({ conn, threadId, want, projectPath, serverVersion, exception, launchPaneId, launchPaneServer, engineId, rest = null, model = null, channel = null }) {
  const noClaim = 'TangleClaw did not look for a dialog and does not claim one.';
  const absentOn = exception && Array.isArray(exception.absentOn) ? exception.absentOn : [];
  /**
   * A reason that opens with what was read about the folder, fitted to the
   * stored length. A long folder path is shortened from its front, so the
   * last sentence, the one the operator acts on, is never the part lost.
   * @param {string} rest - Everything after the sentence naming the folder.
   * @returns {string}
   */
  const fitted = (rest) => {
    const build = (shown) => `Codex's config (read over the channel) has no trust entry for ${shown}. ${rest}`;
    const room = REASON_MAX - build('').length;
    const shown = projectPath.length <= room ? projectPath : `…${projectPath.slice(-(Math.max(room, 1) - 1))}`;
    return build(shown).slice(0, REASON_MAX);
  };
  /**
   * The honest block: what was read, what was not claimed, why nothing was
   * sent, how to grant trust.
   * @param {string} why - Why nothing was sent.
   * @returns {string}
   */
  const honest = (why) => fitted(`${noClaim} ${why} ${HOW_TO_TRUST}`);
  if (!absentOn.includes(serverVersion)) {
    return { allowed: false, reasonCode: 'trust_required', reason: honest(`It is not established for Codex ${serverVersion} whether a trust prompt is shown on this launch path, so nothing was sent.`) };
  }
  const found = await _paneAndThread({
    conn, threadId, want, witness: exception ? exception.witness : undefined, launchPaneId, launchPaneServer, engineId, projectPath, rest, model, channel
  });
  if (found.proven !== true) {
    switch (found.at) {
      case 'no-witness':
        return { allowed: false, reasonCode: 'trust_required', reason: honest('This session\'s pane could not be consulted, so nothing was sent.') };
      case 'no-pane-record':
        return { allowed: false, reasonCode: 'trust_required', reason: honest('The pane this launch created was not recorded, so it could not be consulted and nothing was sent.') };
      case 'version-unproved':
        return { allowed: false, reasonCode: 'pane_not_ready', reason: fitted(`The pane was not consulted: ${_versionUnproved(found)}, so nothing was sent. ${RELAUNCH}`) };
      case 'no-starting-patterns':
        return { allowed: false, reasonCode: 'pane_not_ready', reason: fitted(_noStartingPatterns(engineId)) };
      case 'witness-failed':
        return { allowed: false, reasonCode: 'pane_not_ready', reason: fitted('The pane could not be checked for an empty composer, so nothing was sent. Fire again once the pane shows an empty composer.') };
      case 'dialog': {
        // A trust dialog on the pane is the trust blocker, read from the pane.
        // Any other dialog (the update prompt) is a pane that is not ready.
        const reasonCode = found.dialog.id === TRUST_DIALOG_ID ? 'trust_required' : 'pane_not_ready';
        return { allowed: false, reasonCode, reason: `Codex is showing its ${found.dialog.id} prompt in the pane (read from the pane). TangleClaw does not answer it, so nothing was sent. ${found.dialog.humanAction || 'Answer it in the pane.'} Then Fire again.`.slice(0, REASON_MAX) };
      }
      case 'pane': {
        // A pane that is not the launch's own does not become ready by waiting:
        // only a relaunch restores it.
        const remedy = found.lasting === true ? 'This does not clear by itself: relaunch the session.' : 'Fire again once it is.';
        return { allowed: false, reasonCode: 'pane_not_ready', reason: fitted(`The pane was not seen at an empty composer (${found.why}), so nothing was sent. ${remedy}`) };
      }
      case 'threads':
        return { allowed: false, reasonCode: 'engine_not_ready', reason: `${found.why} (read again after the pane was checked), so nothing was sent`.slice(0, REASON_MAX) };
      case 'thread-unreadable':
        return { allowed: false, reasonCode: 'engine_not_ready', reason: `the launch's thread could not be read again before the send: ${found.error}` };
      case 'thread-changed':
        return { allowed: false, reasonCode: 'engine_not_ready', reason: 'the launch\'s thread changed while the pane was being checked, so nothing was sent' };
      default:
        return { allowed: false, reasonCode: 'engine_not_ready', reason: `the thread became ${found.status || 'unknown'} while the pane was being checked, so nothing was sent` };
    }
  }
  log.info('A startup fire is going without a trust entry in Codex\'s config', { project: projectPath, version: serverVersion });
  return {
    allowed: true,
    note: `Sent without a trust entry in Codex's config for ${projectPath}: at fire time this pane showed an empty composer and no declared trust prompt, and the launch's thread was idle. TangleClaw did not grant trust.`.slice(0, DISPATCH_NOTE_MAX)
  };
}

/**
 * Whether the account can run a turn: only an explicit
 * `ordinaryUsageAllowed: true`, or an explicitly usable positive credit
 * balance, passes. An unavailable answer is unknown, not a pass.
 * @param {object} limits - The `account/rateLimits/read` result.
 * @returns {{state: 'allowed'|'exhausted'|'unknown', reason: string}}
 */
function _usageAllowed(limits) {
  if (!limits || typeof limits !== 'object') return { state: 'unknown', reason: 'the usage read returned nothing' };
  if (limits.ordinaryUsageAllowed === true) return { state: 'allowed', reason: 'ordinary usage allowed' };
  const rl = limits.rateLimits || {};
  const credits = rl.credits;
  const balance = credits && credits.balance !== undefined && credits.balance !== null ? Number(credits.balance) : NaN;
  const usable = !!credits && credits.hasCredits === true && (credits.unlimited === true || (Number.isFinite(balance) && balance > 0));
  if (limits.ordinaryUsageAllowed === false) {
    if (usable) return { state: 'allowed', reason: 'the usage window is exhausted; credits are available' };
    const resets = rl.primary && rl.primary.resetsAt ? new Date(rl.primary.resetsAt * 1000).toISOString() : 'unknown';
    return { state: 'exhausted', reason: `the usage window is exhausted (${rl.rateLimitReachedType || 'rate limit'}) and no usable credits are reported; resets ${resets}` };
  }
  if (usable) return { state: 'allowed', reason: 'credits are available' };
  return { state: 'unknown', reason: 'the usage read did not say whether ordinary usage is allowed' };
}

/**
 * Establish readiness on an open connection (acceptance case 2), reading only
 * the protocol. Returns the thread to fire at, or the blocker. Every unknown
 * answer fails closed as `readiness_unknown`.
 *
 * A folder with no trust entry is not refused where it is read. The remaining
 * checks run first, and only a fire that passes all of them is put to
 * `_withoutTrustEntry`, which may let it go on positive pane evidence and an
 * idle thread read once more after it.
 *
 * @param {AppServerConnection} conn - An opened connection.
 * @param {object} channel - The channel row.
 * @param {object} project - The project.
 * @param {{absentOn?: string[], witness?: Function}} [trustException] - What the fire service supplies for a
 *   folder with no trust entry; absent, such a folder is blocked.
 * @returns {Promise<{ready: true, threadId: string, dispatchNote?: string, threadModel?: (string|null)} | {ready: false, reasonCode: string, reason: string}>}
 *   `threadModel` is present only on a version that declares its rows at rest.
 */
async function _readiness(conn, channel, project, trustException) {
  const state = channel.adapterState || {};
  const serverVersion = _serverVersion(conn.initResult);
  const installed = installedVersion();
  if (!serverVersion || serverVersion !== installed || (state.engineVersion && serverVersion !== state.engineVersion)) {
    return _blocked('version_mismatch', `the app-server reports version ${serverVersion || 'unknown'}; codex-cli ${installed || 'unknown'} is installed and the channel was started on ${state.engineVersion || 'unknown'}`);
  }
  if (state.serverVersion !== serverVersion) {
    try { store.startupControlChannels.setAdapterState(channel.id, { serverVersion }); } catch (err) { log.warn('Could not record the server version', { error: err.message }); }
  }

  let config;
  try {
    config = await conn.call('config/read', {});
  } catch (err) {
    return _blocked('readiness_unknown', `Codex's config could not be read, so trust is unknown: ${err.message}`);
  }
  const trusted = _trusted(config, project.path);
  if (trusted === null) return _blocked('readiness_unknown', 'Codex\'s config answer carries no readable projects table, so trust for the project directory is unknown and nothing was sent');
  if (trusted === 'untrusted') {
    return _blocked('trust_required', `Codex's config (read over the channel) has an entry for ${project.path} that does not trust it. TangleClaw did not look for a dialog and does not claim one, and does not send into a folder Codex was told not to trust. To change that, set trust_level = "trusted" on that entry in Codex's config.toml; then Fire again.`.slice(0, REASON_MAX));
  }

  let account;
  try {
    account = await conn.call('account/read', {});
  } catch (err) {
    return _blocked('readiness_unknown', `the account could not be read: ${err.message}`);
  }
  if (!account || typeof account !== 'object' || !('account' in account)) return _blocked('readiness_unknown', 'the account read answered without an account field');
  if (!account.account) return _blocked('auth_required', 'Codex is not signed in; the operator must log in before the prompt can be fired');

  let limits;
  try {
    limits = await conn.call('account/rateLimits/read', {});
  } catch (err) {
    return _blocked('readiness_unknown', `the usage limits could not be read: ${err.message}`);
  }
  const usage = _usageAllowed(limits);
  if (usage.state === 'exhausted') return _blocked('quota_exhausted', usage.reason);
  if (usage.state === 'unknown') return _blocked('readiness_unknown', usage.reason);

  const want = _canonicalDir(project.path);
  const rest = _restScreen(conn, channel);
  const found = await _launchThread(conn, channel, want, !!rest.footerRe);
  if (found.blocked) return found.blocked;
  const thread = found.thread;
  const status = thread.status && thread.status.type;
  if (status !== 'idle') return _blocked('engine_not_ready', `the thread is ${status || 'in an unknown state'}, not idle`);
  // The model is handed on only where a pane read will be checked against it.
  const seen = rest.footerRe ? { threadModel: typeof thread.model === 'string' ? thread.model : null } : {};
  if (trusted === 'trusted') return { ready: true, threadId: thread.id, ...seen };

  const decided = await _withoutTrustEntry({
    conn, threadId: thread.id, want, projectPath: project.path, serverVersion, exception: trustException,
    launchPaneId: state.paneId || null, launchPaneServer: state.paneServer || null, engineId: channel.engineId,
    rest, model: thread.model, channel
  });
  if (!decided.allowed) return _blocked(decided.reasonCode, decided.reason);
  return { ready: true, threadId: thread.id, dispatchNote: decided.note, ...seen };
}

/**
 * An activity observation.
 * @param {'idle'|'busy'|'unknown'|'held'} state - What the engine reports, or
 *   `held` when its thread is idle and its own config says not to type there.
 * @param {string} reasonCode - Bounded code naming why.
 * @returns {{state: string, reasonCode: string}}
 */
function _activity(state, reasonCode) {
  return { state, reasonCode };
}

/**
 * The loaded threads whose canonical cwd is the project directory, or null
 * when any loaded thread could not be read (it might have been the project's,
 * so "the only one" is no longer knowable).
 * @param {AppServerConnection} conn - An opened connection.
 * @param {string} want - The canonical project directory.
 * @returns {Promise<object[]|null>}
 */
async function _projectThreads(conn, want) {
  let loaded;
  try {
    loaded = await conn.call('thread/loaded/list', {});
  } catch {
    return null;
  }
  const mine = [];
  for (const id of (loaded && loaded.data) || []) {
    let read;
    try {
      read = await conn.call('thread/read', { threadId: id, includeTurns: false });
    } catch {
      return null;
    }
    const t = read && read.thread;
    if (t && typeof t.cwd === 'string' && _canonicalDir(t.cwd) === want) mine.push(t);
  }
  return mine;
}

/** Thread statuses in which a thread is not working: it cannot be mid-turn. */
const RESTING_STATUSES = new Set(['idle', 'systemError', 'notLoaded']);

/**
 * Whether a loaded thread is a subagent, read from the protocol's own
 * metadata: `parentThreadId` is set only for subagents, and their `source`
 * is the `subAgent` variant.
 * @param {object} thread - A thread as `thread/read` returns it.
 * @returns {boolean}
 */
function _isSubagent(thread) {
  if (thread.parentThreadId) return true;
  const src = thread.source;
  return !!src && typeof src === 'object' && ('subAgent' in src || 'subagent' in src);
}

/**
 * What a loaded thread is, on a version measured to load more than one thread
 * for a launch's folder, read from the protocol's own metadata and from
 * nothing else.
 *
 * `launch`: an interactive thread a launch or its operator opened
 * (`threadSource: "user"`, not ephemeral, with a rollout path, no parent).
 * `title`: the helper thread Codex starts after a first turn to name the
 * session (`threadSource: "thread_title"`, ephemeral, no rollout path). It is
 * a thread like any other to `_othersActivity`: while it works, the pane is
 * not at rest. `unidentified`: anything else, including either shape with a
 * field missing or changed, which is never guessed into one of the two.
 * @param {object} thread - A thread as `thread/read` returns it.
 * @returns {'launch'|'title'|'unidentified'}
 */
function _threadKind(thread) {
  const t = thread || {};
  if (t.threadSource === 'user' && t.ephemeral === false && typeof t.path === 'string' && t.path !== '' && (t.parentThreadId === null || t.parentThreadId === undefined)) return 'launch';
  if (t.threadSource === 'thread_title' && t.ephemeral === true && t.path === null) return 'title';
  return 'unidentified';
}

/**
 * What the OTHER loaded threads for the project directory say about the
 * pane, beside an idle bound thread: busy if any is working, since an
 * operator who starts a new thread in the TUI leaves the bound one idle
 * while the new one works; unknown if any is in a status the protocol does
 * not promise; otherwise nothing, and the bound thread's idle stands. A
 * resting extra thread (a finished subagent, an old thread left loaded) is
 * no reason to withhold a wake, and treating it as one starved them (#1978).
 * @param {object[]} others - The other loaded project threads.
 * @returns {{state: string, reasonCode: string}|null}
 */
function _othersActivity(others) {
  let unknown = false;
  for (const t of others) {
    const type = t.status && t.status.type;
    if (type === 'active') return _activity('busy', _isSubagent(t) ? 'subagent-active' : 'other-thread-active');
    if (!RESTING_STATUSES.has(type)) unknown = true;
  }
  return unknown ? _activity('unknown', 'other-thread-status-unknown') : null;
}

/**
 * Is the launch's thread working, read from the protocol alone? A read-only
 * observation of the ENGINE for callers that must not type into a busy one
 * (the Medusa wake): it opens no turn and deliberately skips account and
 * quota, which gate SPENDING a turn, not whether one is running.
 *
 * Trust is read, and only where it can change the answer: a thread about to
 * be reported `idle` is reported `held` instead when Codex's config holds an
 * entry for the project directory that says anything but trusted (see
 * `_folderHeld`). A caller that types on `idle` would otherwise type into a
 * folder the startup fire refuses to send into. A busy or unknown thread is
 * answered without that read.
 *
 * It speaks only for this launch's own app-server (command, socket and birth
 * time, as `_isOurAppServer` checks before any signal) on the recorded
 * version, and for the launch's recorded thread. Other threads loaded for the
 * project directory — subagents, or a thread the operator opened — do not
 * make that thread unknowable, since the recorded one is identified exactly;
 * they can only hold the answer (see `_othersActivity`), never supply it.
 *
 * A channel whose thread was never recorded — its startup fire was blocked, or
 * never ran — may have it bound here, to the SOLE loaded thread for the
 * project directory. That write is TangleClaw's own metadata, compare-and-set
 * so it can never replace a recorded thread or race the fire into two, and
 * before any idle is returned the row is read again: same channel, same
 * launch, the persisted thread the one chosen, and — because that binding was
 * an inference from "the only one" — still the only one loaded.
 *
 * On a version whose rows at rest the profile declares, the answer also names
 * that exact version (`version`): the recorded and the reported one, equal.
 * A caller reads the pane by it. No other answer carries a version.
 *
 * @param {object} channel - The session's open channel row.
 * @param {object} project - The project (its `path`).
 * @param {object} [deps] - Seams: `ClientClass`, `psCommand`, `psBirth`.
 * @returns {Promise<{state: 'idle'|'busy'|'unknown'|'held', reasonCode: string, version?: string}>}
 */
async function observeActivity(channel, project, deps = {}) {
  const state = (channel && channel.adapterState) || {};
  let answer = _activity;
  if (!project || typeof project.path !== 'string') return answer('unknown', 'project-unknown');
  if (!_isOurAppServer(state, deps)) return answer('unknown', 'process-mismatch');

  const got = await _connect(channel, deps);
  if (got.blocker) return answer('unknown', 'channel-unreachable');
  const conn = got.conn;
  try {
    const serverVersion = _serverVersion(conn.initResult);
    if (!serverVersion || serverVersion !== installedVersion() || (state.engineVersion && serverVersion !== state.engineVersion)) {
      return answer('unknown', 'version-mismatch');
    }
    // Where the proved version declares its rows at rest, every answer from
    // here names that version, because the caller's pane gate reads the pane
    // by it; and the launch's thread is chosen by identity, not by being alone.
    const rest = _restScreen(conn, channel);
    const byIdentity = !!rest.footerRe;
    if (byIdentity) answer = (seen, reasonCode) => ({ state: seen, reasonCode, version: rest.version });
    /**
     * The threads an unbound channel may bind: all of them, or on a version
     * read by identity only the launch's own kind, and none while any thread
     * for the folder cannot be identified.
     * @param {object[]} threads - The loaded project threads.
     * @returns {object[]|null} Null when one cannot be identified.
     */
    const eligible = (threads) => {
      if (!byIdentity) return threads;
      if (threads.some((t) => _threadKind(t) === 'unidentified')) return null;
      return threads.filter((t) => _threadKind(t) === 'launch');
    };
    const want = _canonicalDir(project.path);
    let mine = await _projectThreads(conn, want);
    if (!mine) return answer('unknown', 'threads-unreadable');

    // A provisional thread sits in its own field and is not this one: an
    // inference nobody has proved is not a record.
    let threadId = state.threadId || null;
    // Only a binding made by THIS observation is an inference from "the sole
    // loaded thread", so only it is re-confirmed as still the sole one below.
    let boundHere = false;
    if (!threadId && byIdentity) {
      // Bound and proved by the one procedure the launch gate and a fire use,
      // so an inference that fails its check is withdrawn here as it is there.
      const proved = await _proveLaunchThread({
        channel,
        list: async () => {
          const seen = await _projectThreads(conn, want);
          return seen ? { candidates: seen, unreadThreads: 0 } : { failed: 'a loaded thread could not be read' };
        },
        first: { candidates: mine, unreadThreads: 0 }
      });
      if (proved.refused) {
        const code = { unread: 'threads-unreadable', 'list-failed': 'threads-unreadable', none: 'thread-unbound', 'title-only': 'thread-unbound',
          'bind-failed': 'thread-bind-failed', 'confirm-failed': 'thread-bind-failed', 'bind-lost': 'thread-bind-contended' }[proved.refused] || 'thread-ambiguous';
        return answer('unknown', code);
      }
      threadId = proved.thread.id;
      mine = proved.candidates;
    } else if (!threadId) {
      const may = eligible(mine);
      if (!may) return answer('unknown', 'thread-ambiguous');
      if (may.length === 0) return answer('unknown', 'thread-unbound');
      if (may.length > 1) return answer('unknown', 'thread-ambiguous');
      const candidate = may[0].id;
      let bound;
      try {
        bound = store.startupControlChannels.updateAdapterStateIf(channel.id,
          (row) => row.state === 'open' && row.sequenceId === channel.sequenceId && !(row.adapterState && row.adapterState.threadId),
          { threadId: candidate });
      } catch (err) {
        log.warn('Could not bind the channel thread for an observation', { channel: channel.id, error: err.message });
        return answer('unknown', 'thread-bind-failed');
      }
      const persisted = bound.channel && bound.channel.adapterState ? bound.channel.adapterState.threadId : null;
      if (persisted !== candidate) return answer('unknown', 'thread-bind-contended');
      threadId = candidate;
      boundHere = true;
      // Re-establish "the only one" after the write, not from the read before it.
      mine = await _projectThreads(conn, want);
      if (!mine) return answer('unknown', 'threads-unreadable');
    }

    const bound = mine.find((t) => t.id === threadId);
    if (!bound) return answer('unknown', 'thread-not-loaded');
    if (boundHere) {
      const may = eligible(mine);
      if (!may || may.length !== 1 || may[0].id !== threadId) return answer('unknown', 'thread-ambiguous');
    }
    const status = bound.status && bound.status.type;
    if (status === 'active') return answer('busy', 'thread-active');
    if (status !== 'idle') return answer('unknown', 'thread-status-unknown');
    const others = _othersActivity(mine.filter((t) => t !== bound));
    if (others) return answer(others.state, others.reasonCode);

    const held = await _folderHeld(conn, channel, project);

    // An idle answer is the one a caller acts on, so it is only given for the
    // channel generation it was read under. A held one is given under the same
    // condition: it too speaks for this launch's thread.
    let now;
    try {
      now = store.startupControlChannels.get(channel.id);
    } catch {
      return answer('unknown', 'channel-changed');
    }
    if (!now || now.state !== 'open' || now.sequenceId !== channel.sequenceId || !now.adapterState || now.adapterState.threadId !== threadId
      || (byIdentity && now.adapterState.provisionalThreadId)) {
      return answer('unknown', 'channel-changed');
    }
    return held ? answer('held', 'folder-untrusted') : answer('idle', 'thread-idle');
  } finally {
    conn.close();
  }
}

/**
 * Channels already warned about for a trust read that could not be made, so
 * the warning is given once per launch and not once per observation. A
 * channel row is one launch of one session, and only a launch whose read
 * fails adds an id, so the set grows by the number of such launches in the
 * life of the process.
 * @type {Set<number>}
 */
const _trustUnreadWarned = new Set();

/**
 * Does Codex's config hold an entry for the project directory that says
 * anything but trusted? Asked on the connection an observation already has
 * open, as the last thing before it would answer `idle`.
 *
 * Only a readable entry holds. No entry, and a `null` projects table, do not:
 * a nudge is typed into the composer as an operator's own typing would be.
 * A read that fails, or an answer this code cannot understand, does not hold
 * either, because an unreadable config must not stop mail. That last case
 * establishes nothing about trust, so it is warned about, once per launch.
 * @param {AppServerConnection} conn - The observation's open connection.
 * @param {object} channel - The channel row (`id`).
 * @param {object} project - The project (`path`).
 * @returns {Promise<boolean>} True only for a readable entry that is not trusted.
 */
async function _folderHeld(conn, channel, project) {
  let trusted = null;
  let why = 'its answer carries no readable projects table';
  try {
    trusted = _trusted(await conn.call('config/read', {}), project.path);
  } catch (err) {
    why = err.message;
  }
  if (trusted === null && !_trustUnreadWarned.has(channel.id)) {
    _trustUnreadWarned.add(channel.id);
    log.warn('Codex\'s config could not be read during an activity observation, so trust for the project directory is not established and a wake is not held on it', {
      channel: channel.id, project: project.path, error: why,
      hint: 'If this folder is meant to be untrusted, check that Codex\'s config.toml parses; the wake holds only on an entry it can read.'
    });
  }
  return trusted === 'untrusted';
}

/**
 * Open a connection to a channel's app-server, or say why not.
 * @param {object} channel - The channel row.
 * @param {object} deps - Seams.
 * @returns {Promise<{conn: AppServerConnection} | {blocker: object}>}
 */
async function _connect(channel, deps) {
  const socketPath = channel.adapterState && channel.adapterState.resolvedSocketPath;
  if (!socketPath) return { blocker: _blocked('engine_not_ready', 'the channel records no socket') };
  const conn = new AppServerConnection(socketPath, deps);
  try {
    conn.initResult = await conn.open();
    return { conn };
  } catch (err) {
    conn.close();
    return { blocker: _blocked('engine_not_ready', `the app-server did not answer: ${err.message}`) };
  }
}

/**
 * The text of a user item's content, as the engine echoes it.
 * @param {object} item - A userMessage item.
 * @returns {string}
 */
function _itemText(item) {
  return ((item && item.content) || []).filter((c) => c && c.type === 'text').map((c) => String(c.text)).join('');
}

/**
 * The userMessage item in a turn record that carries our digest AND whose
 * text is exactly the prompt's bytes, if any. A correct clientId never
 * blesses wrong text.
 * @param {object} turn - A Turn.
 * @param {string} digest - The payload digest.
 * @param {string} promptTextDigest - SHA-256 of the prompt text.
 * @returns {object|null}
 */
function _echoedItem(turn, digest, promptTextDigest) {
  for (const item of (turn && turn.items) || []) {
    if (item && item.type === 'userMessage' && item.clientId === digest && _sha256(_itemText(item)) === promptTextDigest) return item;
  }
  return null;
}

/**
 * The outcome a finished turn maps to, or null while it runs.
 * @param {object} turn - A Turn.
 * @returns {{outcome: string, reasonCode: (string|null), reason: (string|null)}|null}
 */
function _turnOutcome(turn) {
  if (!turn) return null;
  switch (turn.status) {
    case 'completed':
      return { outcome: 'applied', reasonCode: null, reason: null };
    case 'failed': {
      const info = turn.error && turn.error.codexErrorInfo;
      const code = typeof info === 'string' ? info : (info && Object.keys(info)[0]) || 'unknown';
      return { outcome: 'failed', reasonCode: 'turn_failed', reason: `the turn failed (${code}): ${(turn.error && turn.error.message) || ''}`.trim() };
    }
    case 'interrupted':
      return { outcome: 'interrupted', reasonCode: 'turn_interrupted', reason: 'the turn was interrupted before it completed (the operator declined or stopped it)' };
    default:
      return null;
  }
}

/**
 * Read every page of a thread's turns.
 * @param {AppServerConnection} conn - Connection.
 * @param {string} threadId - Thread.
 * @returns {Promise<{turns: object[], complete: boolean}>} `complete` is false when a page failed or the cap was hit.
 */
async function _allTurns(conn, threadId) {
  const turns = [];
  let cursor = null;
  for (let page = 0; page < MAX_TURN_PAGES; page++) {
    let list;
    try {
      list = await conn.call('thread/turns/list', { threadId, itemsView: 'full', cursor: cursor || undefined });
    } catch (err) {
      return { turns, complete: false, error: err };
    }
    for (const t of (list && list.data) || []) turns.push(t);
    cursor = list && list.nextCursor ? list.nextCursor : null;
    if (!cursor) return { turns, complete: true };
  }
  return { turns, complete: false };
}

/**
 * Fire the prompt at a session's channel and drive the receipt.
 *
 * The caller has already written the fire's intent row (`pending`) and
 * commits every transition this function reports through `onUpdate`. The
 * returned `accepted` promise settles when the engine has echoed the payload
 * digest with the prompt's bytes (or the fire ended first); `settled` settles
 * at a terminal outcome or at `indeterminate`.
 *
 * @param {object} input
 * @param {object} input.session - The target session row.
 * @param {object} input.project - Its project.
 * @param {number} input.sequenceId - The launch the fire is bound to.
 * @param {string} input.promptText - The prompt to send.
 * @param {string} input.promptTextDigest - SHA-256 of the prompt's exact bytes.
 * @param {string} input.payloadDigest - The launch-start payload digest.
 * @param {(patch: object) => object} input.onUpdate - Applies a transition; returns the row.
 * @param {{absentOn?: string[], witness?: Function}} [input.trustException] - For a folder with no trust entry in
 *   Codex's config (#2186): the versions measured to draw no trust dialog on this launch path, and a pane witness.
 * @param {boolean} [input.automatic] - True only for the launch's own automatic fire, said by the fire service
 *   and never inferred here. Such a fire reads the pane and the thread once more immediately before it sends.
 * @param {Function} [input.paneWitness] - The pane witness for that last read; without one an automatic fire sends nothing.
 * @param {object} [deps] - Seams.
 * @returns {{accepted: Promise<object>, settled: Promise<object>}}
 */
function fire(input, deps = {}) {
  let resolveAccepted;
  const accepted = new Promise((resolve) => { resolveAccepted = resolve; });
  const settled = _fire(input, deps, (row) => resolveAccepted(row));
  settled.then((row) => resolveAccepted(row), () => resolveAccepted(null));
  return { accepted, settled };
}

/**
 * The automatic fire's last look: one fresh read of the launch's pane and one
 * more read of its thread, by the same check the launch gate passed
 * (`_paneAndThread`). Returns why nothing may be sent, or null when the pane
 * still shows an empty composer and the thread is still idle.
 *
 * A proof that could not be made is said to be unavailable. It is never
 * worded as a pane that was seen not ready.
 * @param {AppServerConnection} conn - The fire's open connection.
 * @param {object} channel - The channel row.
 * @param {object} project - The project.
 * @param {string} threadId - The launch's thread.
 * @param {Function|undefined} witness - The pane witness the fire service supplies.
 * @param {string|null} [model=null] - The launch thread's model as the readiness read reported it.
 * @returns {Promise<string|null>}
 */
async function _sendTimeRefusal(conn, channel, project, threadId, witness, model = null) {
  const state = channel.adapterState || {};
  const found = await _paneAndThread({
    conn, threadId, want: _canonicalDir(project.path), witness, launchPaneId: state.paneId || null, launchPaneServer: state.paneServer || null,
    engineId: channel.engineId, projectPath: project.path, single: true, rest: _restScreen(conn, channel), model, channel
  });
  if (found.proven === true) return null;
  const said = _launchRefusal(found, channel.engineId);
  if (said.whole) return said.whole.slice(0, REASON_MAX);
  const lead = said.unavailable
    ? 'The proof that the pane still showed an empty composer and an idle thread was unavailable immediately before the send'
    : 'The pane was seen ready at the launch gate and was not seen ready immediately before the send';
  return _fitReason(`${lead}, so nothing was sent: `, said.observation, `. ${said.remedy}`);
}

/**
 * A reason of the stored length whose middle gives way first, so the sentence
 * the operator acts on is never the part cut off.
 * @param {string} lead - What opens the reason.
 * @param {string} middle - What was observed; shortened if the whole does not fit.
 * @param {string} tail - What the operator does.
 * @returns {string}
 */
function _fitReason(lead, middle, tail) {
  const room = REASON_MAX - lead.length - tail.length;
  const shown = middle.length <= room ? middle : `${middle.slice(0, Math.max(room, 1) - 1)}…`;
  return `${lead}${shown}${tail}`.slice(0, REASON_MAX);
}

/**
 * The fire itself; see {@link fire}.
 * @param {object} input - As `fire`.
 * @param {object} deps - Seams.
 * @param {(row: object) => void} onAccepted - Called once the engine echoed the digest.
 * @returns {Promise<object>} The final row.
 */
async function _fire(input, deps, onAccepted) {
  const { session, project, sequenceId, promptText, promptTextDigest, payloadDigest, onUpdate, trustException, automatic, paneWitness } = input;
  let channel = null;
  try {
    channel = store.startupControlChannels.getOpenBySession(session.id);
  } catch (err) {
    return onUpdate({ outcome: 'blocked', reasonCode: 'engine_not_ready', reason: `the channel record could not be read: ${err.message}` });
  }
  if (!channel || channel.adapter !== NAME) {
    let why = 'it was launched without one';
    try {
      const last = store.startupControlChannels.getLatestBySession(session.id);
      if (last && last.state === 'closed' && last.closeReason) why = `${last.closeReason}`;
    } catch { /* the generic reason stands */ }
    return onUpdate({ outcome: 'blocked', reasonCode: 'channel_unavailable', reason: `this session has no native channel: ${why}` });
  }
  if (Number.isInteger(sequenceId) && channel.sequenceId !== sequenceId) {
    return onUpdate({ outcome: 'blocked', reasonCode: 'engine_not_ready', reason: 'the session\'s channel belongs to a different launch than this fire' });
  }
  const opened = await _connect(channel, deps);
  if (opened.blocker) return onUpdate({ outcome: 'blocked', reasonCode: opened.blocker.reasonCode, reason: opened.blocker.reason });
  const conn = opened.conn;
  let watcher = null;
  try {
    const ready = await _readiness(conn, channel, project, trustException);
    if (!ready.ready) return onUpdate({ outcome: 'blocked', reasonCode: ready.reasonCode, reason: ready.reason });
    const threadId = ready.threadId;

    // The launch's own fire was let through by a gate that saw the pane ready
    // some time ago, and the service has done its work since. That is not a
    // standing permission: the pane and the thread are read once more here, as
    // the last thing before the send, in a trusted folder as much as any other.
    // An operator's Fire is their own look at the pane and is not put to this.
    if (automatic === true) {
      const held = await _sendTimeRefusal(conn, channel, project, threadId, paneWitness, ready.threadModel);
      if (held) return onUpdate({ outcome: 'blocked', reasonCode: 'pane_not_ready', reason: held });
    }

    watcher = new TurnWatcher({ conn, threadId, payloadDigest, promptTextDigest, onUpdate, onAccepted, channel, deps });
    watcher.listen(conn);

    const row = onUpdate({ outcome: 'dispatching', reason: null, engineThreadId: threadId, ...(ready.dispatchNote ? { dispatchNote: ready.dispatchNote } : {}) });
    if (!row || row.outcome !== 'dispatching') {
      watcher.finished = true;
      return row;
    }

    let response;
    try {
      response = await conn.call('turn/start', {
        threadId,
        input: [{ type: 'text', text: promptText }],
        clientUserMessageId: payloadDigest
      }, TURN_START_TIMEOUT_MS);
    } catch (err) {
      watcher.finished = true;
      if (err.code === 'CLOSED' || err.code === 'TIMEOUT') {
        return onUpdate({ outcome: 'indeterminate', reasonCode: 'send_unconfirmed', reason: `turn/start was sent but not answered (${err.message}); never retried automatically` });
      }
      return onUpdate({ outcome: 'failed', reasonCode: 'turn_rejected', reason: `the engine rejected the turn (${err.code}): ${err.message}` });
    }
    const turn = response && response.turn;
    if (!turn || !turn.id) {
      watcher.finished = true;
      return onUpdate({ outcome: 'indeterminate', reasonCode: 'send_unconfirmed', reason: 'turn/start answered without a turn id; never retried automatically' });
    }
    watcher.turnId = turn.id;
    onUpdate({ outcome: 'dispatching', engineTurnId: turn.id, engineThreadId: threadId });
    await watcher.consider(turn);
    await watcher.subscribeAndReadBack();
    watcher.startPolling();
    return await watcher.done;
  } finally {
    if (!watcher || watcher.finished) conn.close();
  }
}

/**
 * Follows one turn to its end: notifications while the socket lives, a
 * read-back of the engine's own turn record after a subscription, after an
 * early completion, and after every reconnect, and a bounded number of
 * reconnects before the fire is left indeterminate. Applied is recorded only
 * after accepted evidence exists for the same turn.
 */
class TurnWatcher {
  /**
   * @param {object} args - `conn, threadId, payloadDigest, promptTextDigest, onUpdate, onAccepted, channel, deps`, and optionally `turnId`.
   */
  constructor(args) {
    Object.assign(this, { turnId: null }, args);
    this.acceptedSeen = false;
    this.finished = false;
    this.reconnects = 0;
    this.row = null;
    this.polling = false;
    this._poll = null;
    this.done = new Promise((resolve) => { this._resolve = resolve; });
  }

  /**
   * Re-read the turn record on an interval until the fire ends, so a turn
   * whose end no notification reports is still settled from the record.
   * @returns {void}
   */
  startPolling() {
    if (this._poll || this.finished) return;
    const pollMs = this.deps.pollMs !== undefined ? this.deps.pollMs : WATCH_POLL_MS;
    this._poll = setInterval(() => {
      if (this.finished || this.polling || !this.conn || this.conn.closed) return;
      this.polling = true;
      this.readBack().catch((err) => log.warn('watch poll failed', { error: err.message })).finally(() => { this.polling = false; });
    }, pollMs);
    if (this._poll.unref) this._poll.unref();
  }

  /**
   * Attach to a connection's events.
   * @param {AppServerConnection} conn - The connection.
   * @returns {void}
   */
  listen(conn) {
    conn.on('notification', (n) => { this._onNotification(n).catch((err) => log.warn('watch notification failed', { error: err.message })); });
    conn.on('closed', () => { this._onClosed().catch((err) => log.warn('watch reconnect failed', { error: err.message })); });
    conn.on('serverRequest', (r) => {
      // Never answered: an approval or a question is the operator's, in the TUI.
      log.info('app-server asked the operator for something; left to the pane', { method: r.method });
    });
  }

  /**
   * Apply a transition and remember the row.
   * @param {object} patch - Transition.
   * @returns {object}
   */
  _update(patch) {
    this.row = this.onUpdate(patch);
    return this.row;
  }

  /**
   * Finish with a terminal or indeterminate row.
   * @param {object} patch - The final transition.
   * @returns {void}
   */
  _finish(patch) {
    if (this.finished) return;
    this.finished = true;
    if (this._poll) clearInterval(this._poll);
    const row = patch ? this._update(patch) : this.row;
    try { if (this.conn) this.conn.close(); } catch { /* closing */ }
    this._resolve(row);
  }

  /**
   * Mark accepted once, from whichever evidence came first.
   * @returns {void}
   */
  _accept() {
    if (this.acceptedSeen || this.finished) return;
    this.acceptedSeen = true;
    const row = this._update({ outcome: 'accepted', reason: null, engineTurnId: this.turnId });
    try { this.onAccepted(row); } catch { /* the caller's promise is already settled */ }
  }

  /**
   * Weigh a turn record. A finished turn with no accepted evidence yet is
   * read back once before it is judged, so an early completion is reconciled
   * rather than skipped.
   * @param {object} turn - A Turn.
   * @param {boolean} [fromReadBack=false] - Whether this record is already the read-back.
   * @returns {Promise<void>}
   */
  async consider(turn, fromReadBack = false) {
    if (!turn || this.finished) return;
    if (this.turnId && turn.id !== this.turnId) return;
    if (_echoedItem(turn, this.payloadDigest, this.promptTextDigest)) this._accept();
    const outcome = _turnOutcome(turn);
    if (!outcome) return;
    if (!this.acceptedSeen && !fromReadBack) {
      const read = await this.readBack();
      // Found: judged from the record. Unreadable: nothing is known, the poll
      // will read again; a completion is never judged from a summary alone.
      if (read !== 'absent' || this.finished) return;
    }
    if (this.finished) return;
    if (outcome.outcome === 'applied' && !this.acceptedSeen) {
      this._finish({ outcome: 'failed', reasonCode: 'send_unconfirmed', reason: 'the turn completed but its record carries no user message with this fire\'s digest and text' });
      return;
    }
    this._finish(outcome);
  }

  /**
   * Subscribe to the thread (possible now that the turn materialized it) and
   * read the turn back once, so nothing emitted before the subscription is
   * lost.
   * @returns {Promise<void>}
   */
  async subscribeAndReadBack() {
    if (this.finished) return;
    try {
      await this.conn.call('thread/resume', { threadId: this.threadId, excludeTurns: true });
    } catch (err) {
      log.warn('thread/resume after turn/start failed; relying on the read-back', { error: err.message });
    }
    await this.readBack();
  }

  /**
   * Read the engine's record of the turn and weigh it.
   * @returns {Promise<'found'|'absent'|'unreadable'>} 'unreadable' when the list
   *   could not be read in full: that says nothing about the turn and settles nothing.
   */
  async readBack() {
    if (this.finished) return 'found';
    const listed = await _allTurns(this.conn, this.threadId);
    const turn = listed.turns.find((t) => t && t.id === this.turnId);
    if (turn) {
      await this.consider(turn, true);
      return 'found';
    }
    if (!listed.complete) {
      log.warn('thread/turns/list could not be read in full during the watch', { error: listed.error ? listed.error.message : 'page cap' });
      return 'unreadable';
    }
    return 'absent';
  }

  /**
   * One notification from the engine.
   * @param {{method: string, params: object}} n - The notification.
   * @returns {Promise<void>}
   */
  async _onNotification(n) {
    if (this.finished) return;
    const p = n.params || {};
    switch (n.method) {
      case 'item/completed':
        if (p.threadId === this.threadId && p.turnId === this.turnId && p.item && p.item.type === 'userMessage'
          && _echoedItem({ id: this.turnId, items: [p.item] }, this.payloadDigest, this.promptTextDigest)) {
          this._accept();
        }
        return;
      case 'turn/completed':
        if (p.threadId === this.threadId && p.turn && p.turn.id === this.turnId) await this.consider(p.turn);
        return;
      case 'thread/status/changed': {
        if (p.threadId !== this.threadId || !this.acceptedSeen) return;
        const flags = p.status && p.status.type === 'active' ? p.status.activeFlags || [] : [];
        if (flags.includes('waitingOnApproval')) {
          this._update({ outcome: 'accepted', reasonCode: 'approval_pending', reason: 'the turn is waiting on an approval in the pane; the operator answers it there' });
        } else if (flags.includes('waitingOnUserInput')) {
          this._update({ outcome: 'accepted', reasonCode: 'user_input_pending', reason: 'the turn is waiting on user input in the pane; the operator answers it there' });
        } else if (this.row && (this.row.reasonCode === 'approval_pending' || this.row.reasonCode === 'user_input_pending')) {
          this._update({ outcome: 'accepted', reasonCode: null, reason: null });
        }
        return;
      }
      default:
    }
  }

  /**
   * The socket went away mid-watch: reconnect, bounded, and read back.
   * @returns {Promise<void>}
   */
  async _onClosed() {
    if (this.finished) return;
    const pause = this.deps.reconnectPauseMs !== undefined ? this.deps.reconnectPauseMs : WATCH_RECONNECT_PAUSE_MS;
    while (!this.finished && this.reconnects < WATCH_RECONNECTS) {
      this.reconnects += 1;
      await new Promise((r) => setTimeout(r, pause));
      if (this.finished) return;
      const opened = await _connect(this.channel, this.deps);
      if (opened.blocker) continue;
      this.conn = opened.conn;
      this.listen(this.conn);
      try {
        await this.conn.call('thread/resume', { threadId: this.threadId, excludeTurns: true });
      } catch { /* the read-back still tells us where the turn stands */ }
      const read = await this.readBack();
      if (read === 'found' || this.finished) return;
    }
    if (!this.finished) {
      this._finish({ outcome: 'indeterminate', reasonCode: 'channel_lost', reason: `the channel was lost while the turn ran and ${WATCH_RECONNECTS} reconnects found no record of it; never retried automatically` });
    }
  }
}

/**
 * Resume following an accepted fire after a restart: reconnect, subscribe,
 * read back, then watch. Nothing is resent.
 * @param {{session: object, fire: object, onUpdate: Function}} input - The fire.
 * @param {object} deps - Seams.
 * @returns {void}
 */
function _resumeWatch(input, deps) {
  const { session, fire: row, onUpdate } = input;
  const channel = store.startupControlChannels.getOpenBySession(session.id);
  if (!channel || !row.engineThreadId || !row.engineTurnId) {
    onUpdate({ outcome: 'indeterminate', reasonCode: 'channel_lost', reason: 'the accepted fire cannot be followed after the restart: its thread or turn is not recorded' });
    return;
  }
  const watcher = new TurnWatcher({
    conn: null, threadId: row.engineThreadId, turnId: row.engineTurnId, payloadDigest: row.payloadDigest,
    promptTextDigest: row.promptTextDigest, onUpdate, onAccepted: () => {}, channel, deps
  });
  watcher.acceptedSeen = true;
  watcher.row = row;
  watcher._onClosed()
    .then(() => watcher.startPolling())
    .catch((err) => log.warn('Could not resume a fire watch', { fire: row.id, error: err.message }));
}

/**
 * Settle an indeterminate fire from the engine's own record. Never
 * sends anything. `failed` is recorded only after every page of the exact
 * materialized thread, on the reachable channel, shows the payload absent
 * while the thread stayed idle across a pause.
 *
 * @param {object} input
 * @param {object} input.session - The session.
 * @param {object} input.fire - The indeterminate fire row.
 * @param {(patch: object) => object} input.onUpdate - Applies a transition.
 * @param {object} [deps] - Seams: `stableIdleMs`.
 * @returns {Promise<object>} The row after the reconcile.
 */
async function reconcile(input, deps = {}) {
  const { session, fire: row, onUpdate } = input;
  let channel = null;
  try { channel = store.startupControlChannels.getOpenBySession(session.id); } catch { channel = null; }
  if (!channel || channel.adapter !== NAME) {
    return onUpdate({ outcome: 'indeterminate', reasonCode: 'channel_lost', reason: 'no open channel to reconcile against; relaunch the session' });
  }
  const opened = await _connect(channel, deps);
  if (opened.blocker) {
    return onUpdate({ outcome: 'indeterminate', reasonCode: 'channel_lost', reason: `the app-server could not be reached to reconcile: ${opened.blocker.reason}` });
  }
  const conn = opened.conn;
  try {
    const threadId = row.engineThreadId || (channel.adapterState && channel.adapterState.threadId);
    if (!threadId) {
      return onUpdate({ outcome: 'indeterminate', reasonCode: 'channel_lost', reason: 'no thread is recorded for this fire, so its turn cannot be looked up' });
    }
    try { await conn.call('thread/resume', { threadId, excludeTurns: true }); } catch { /* the list may still answer */ }
    const readStatus = async () => {
      const read = await conn.call('thread/read', { threadId, includeTurns: false });
      return read && read.thread && read.thread.status && read.thread.status.type;
    };
    const listed = await _allTurns(conn, threadId);
    if (!listed.complete) {
      const notMaterialized = listed.error && /not materialized/i.test(listed.error.message);
      if (!notMaterialized) {
        return onUpdate({ outcome: 'indeterminate', reasonCode: 'send_unconfirmed', reason: `the thread's turns could not be read in full${listed.error ? `: ${listed.error.message}` : ''}; it stays indeterminate` });
      }
    }
    const turn = listed.turns.find((t) => _echoedItem(t, row.payloadDigest, row.promptTextDigest));
    if (turn) {
      // The echo is accepted evidence, stamped before the turn's own end so the
      // record reads like a watched fire: accepted, then applied.
      const acceptedRow = onUpdate({ outcome: 'accepted', reason: null, engineTurnId: turn.id });
      const outcome = _turnOutcome(turn);
      if (outcome) return onUpdate({ ...outcome, engineTurnId: turn.id });
      return acceptedRow;
    }
    const first = await readStatus();
    if (first !== 'idle' && first !== 'notLoaded') {
      return onUpdate({ outcome: 'indeterminate', reasonCode: 'send_unconfirmed', reason: `the thread is ${first || 'in an unknown state'} and carries no turn with this fire's digest yet` });
    }
    await new Promise((r) => setTimeout(r, deps.stableIdleMs !== undefined ? deps.stableIdleMs : STABLE_IDLE_MS));
    const second = await readStatus();
    const again = await _allTurns(conn, threadId);
    const stillAbsent = again.complete || (again.error && /not materialized/i.test(again.error.message));
    if ((second === 'idle' || second === 'notLoaded') && stillAbsent && !again.turns.some((t) => _echoedItem(t, row.payloadDigest, row.promptTextDigest))) {
      return onUpdate({ outcome: 'failed', reasonCode: 'send_unconfirmed', reason: 'the engine has no record of this fire\'s turn on any page and the thread stayed idle: the send never landed' });
    }
    return onUpdate({ outcome: 'indeterminate', reasonCode: 'send_unconfirmed', reason: `the thread was ${second || 'in an unknown state'} on the second read; it stays indeterminate` });
  } finally {
    conn.close();
  }
}

/**
 * What the launch's app-server says about the project's loaded threads, for a
 * managed coordinator rotation (#2032). Read-only, like `observeActivity`, and
 * gated the same way: only this launch's own app-server on the recorded
 * version is asked, and one unreadable thread makes the whole answer
 * unknowable rather than partial.
 * @param {object} channel - The session's open channel row.
 * @param {object} project - The project (its `path`).
 * @param {object} [deps] - Seams: `ClientClass`, `psCommand`, `psBirth`.
 * @returns {Promise<{threads: Array<{id: string, status: string|null, subagent: boolean}>}|{blocker: string}>}
 */
async function rotationThreads(channel, project, deps = {}) {
  const state = (channel && channel.adapterState) || {};
  if (!project || typeof project.path !== 'string') return { blocker: 'project-unknown' };
  if (!_isOurAppServer(state, deps)) return { blocker: 'process-mismatch' };
  const got = await _connect(channel, deps);
  if (got.blocker) return { blocker: 'channel-unreachable' };
  const conn = got.conn;
  try {
    const serverVersion = _serverVersion(conn.initResult);
    if (!serverVersion || serverVersion !== installedVersion() || (state.engineVersion && serverVersion !== state.engineVersion)) {
      return { blocker: 'version-mismatch' };
    }
    const mine = await _projectThreads(conn, _canonicalDir(project.path));
    if (!mine) return { blocker: 'threads-unreadable' };
    return {
      threads: mine.map((t) => ({ id: t.id, status: (t.status && t.status.type) || null, subagent: _isSubagent(t) }))
    };
  } finally {
    conn.close();
  }
}

/**
 * Replace the channel's recorded thread with the replacement a managed
 * rotation proved (#2032). The one writer allowed to move a recorded thread:
 * `observeActivity` and the startup fire only ever bind an EMPTY slot. A
 * compare-and-set on the row as the rotation recorded it — same channel, still
 * open, same launch sequence, and the recorded thread still the prior one (or
 * already the replacement, so a retry after a crash converges).
 * @param {object} channel - The channel row the rotation recorded.
 * @param {{priorThreadId: string, replacementThreadId: string}} ids - The move.
 * @returns {{written: boolean, bound: boolean, channel: (object|null)}} `bound` is
 *   true when the row now names the replacement, whether this call wrote it or not.
 */
function rebindThread(channel, { priorThreadId, replacementThreadId }) {
  const result = store.startupControlChannels.updateAdapterStateIf(channel.id,
    (row) => row.state === 'open' && row.sequenceId === channel.sequenceId
      && row.adapterState && row.adapterState.threadId === priorThreadId,
    { threadId: replacementThreadId });
  const now = result.channel;
  const bound = !!(now && now.state === 'open' && now.sequenceId === channel.sequenceId
    && now.adapterState && now.adapterState.threadId === replacementThreadId);
  return { written: result.written, bound, channel: now };
}

/**
 * Deliver one turn to a named thread at most once per `clientId` (#2032's
 * re-entry instruction). Before sending, the thread's turns are read back: a
 * user item that already carries `clientId` means an earlier attempt landed,
 * and nothing is sent again. The client id alone decides, because the text
 * carries a one-time secret minted fresh for each send: a landed earlier text
 * is the one that counts. `text` is a function, called only when a turn will
 * actually be sent, so the secret is minted only then. A thread with no turns
 * yet answers the read-back with "not materialized", which is an empty
 * history; any other read failure is unknown, and nothing is sent.
 * @param {object} channel - The session's open channel row.
 * @param {object} project - The project (its `path`).
 * @param {{threadId: string, text: (function(): string), clientId: string}} turn - What to send.
 * @param {object} [deps] - Seams: `ClientClass`, `psCommand`, `psBirth`.
 * @returns {Promise<{status: 'sent'|'already'}|{blocker: string}>}
 */
async function deliverTurn(channel, project, { threadId, text, clientId }, deps = {}) {
  const state = (channel && channel.adapterState) || {};
  if (!_isOurAppServer(state, deps)) return { blocker: 'process-mismatch' };
  const got = await _connect(channel, deps);
  if (got.blocker) return { blocker: 'channel-unreachable' };
  const conn = got.conn;
  try {
    const serverVersion = _serverVersion(conn.initResult);
    if (!serverVersion || serverVersion !== installedVersion() || (state.engineVersion && serverVersion !== state.engineVersion)) {
      return { blocker: 'version-mismatch' };
    }
    const read = await _allTurns(conn, threadId);
    const unmaterialized = read.error && /not materialized/i.test(String(read.error.message || ''));
    if (!read.complete && !unmaterialized) return { blocker: 'turns-unreadable' };
    const landed = read.turns.some((t) => ((t && t.items) || []).some((item) => item && item.type === 'userMessage' && item.clientId === clientId));
    if (landed) return { status: 'already' };
    let body;
    try {
      body = text();
    } catch (err) {
      log.warn('Rotation re-entry turn could not be prepared', { channel: channel.id, error: err.message });
      return { blocker: 'turn-text-failed' };
    }
    try {
      await conn.call('turn/start', { threadId, input: [{ type: 'text', text: body }], clientUserMessageId: clientId }, TURN_START_TIMEOUT_MS);
    } catch (err) {
      log.warn('Rotation re-entry turn was not started', { channel: channel.id, error: err.message });
      return { blocker: 'turn-start-failed' };
    }
    return { status: 'sent' };
  } finally {
    conn.close();
  }
}

module.exports = {
  NAME,
  installedVersion,
  loopbackSandboxNote,
  probeVersion,
  probeVersionSync,
  probeForLaunch,
  admitExecutable,
  isolateLaunch,
  judgeLaunchCommand,
  judgeOverriddenLaunch,
  judgeRecordedCommand,
  OVERRIDABLE_REFUSALS,
  prepareLaunch,
  attachLaunch,
  abandonLaunch,
  releaseSession,
  reap,
  recover,
  start,
  stop,
  fire,
  reconcile,
  observeActivity,
  awaitLaunchReady,
  rotationThreads,
  rebindThread,
  deliverTurn,
  AppServerConnection,
  _seams,
  _internal: {
    _serverEnvironment, _version, _unanswered, _trustUnreadWarned, PROBE_UNANSWERED_MEMORY_MS, VERSION_PROBE_TIMEOUT_MS, _parseVersion, _supportsNoDaemon, _shellWord, _launchesCodex, NO_DAEMON_VERSIONS, RECOMMENDED_VERSION, INSTALL_COMMAND, PLAIN_ARGUMENT, _resolveSocket, _canonicalDir, _isOurAppServer, _terminate, _trusted, _usageAllowed,
    _serverVersion, _echoedItem, _itemText, _turnOutcome, _readiness, _allTurns, TurnWatcher, RUN_DIRNAME, SAFE_PATH,
    _paneAndThread, _threadKind, _statusRowPattern, _restScreen, LAUNCH_READY_WINDOW_MS, LAUNCH_READY_POLL_MS
  }
};
