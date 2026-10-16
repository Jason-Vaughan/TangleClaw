'use strict';

/**
 * The judgment of a command a running pane was started with: was that session
 * kept off Codex's shared background process? It reads the recorded command
 * string and nothing else, so it needs nothing beyond Node's own modules.
 *
 * It lives apart from `lib/startup-control-codex.js` so that `tc` can load it.
 * That adapter requires the store, and the store's `node:sqlite` prints an
 * ExperimentalWarning that would appear on a session's every `tc whoami`.
 * Keep this module store-free: require no `lib/` module, and
 * `test/recorded-launch-command.test.js` checks in a fresh process that
 * loading it reaches no `lib/store.js`.
 *
 * The adapter and `lib/sessions.js` re-export what lives here, so their callers
 * and the launch judgment read a command by these same definitions.
 */

const path = require('node:path');

/** The characters a resolved socket path may contain before it is placed in a shell command. */
const SAFE_PATH = /^[A-Za-z0-9_./-]+$/;

/** The name of the executable whose launches this adapter judges. */
const ENGINE_BINARY = 'codex';

/**
 * One launch argument a shell passes through unchanged: letters, digits and
 * the punctuation that has no meaning to a shell anywhere in an unquoted
 * word. A word is accepted by what it contains, never by the absence of
 * known-dangerous characters, so a character nobody thought of is refused.
 * `=` is allowed only after the first character, where it expands nothing.
 * `~` is never allowed.
 */
const PLAIN_ARGUMENT = /^[A-Za-z0-9_.,:@%+/-][A-Za-z0-9_.,:=@%+/-]*$/;

/**
 * An executable path as one shell word, or null when it cannot be made one
 * safely. A path of plain characters is used as it is; any other is wrapped
 * in single quotes, which take every character literally except a single
 * quote itself, so a path holding one (or a line break) is refused.
 * @param {string} enginePath - Absolute path to the executable.
 * @returns {string|null}
 */
function _shellWord(enginePath) {
  if (typeof enginePath !== 'string' || !path.isAbsolute(enginePath)) return null;
  if (SAFE_PATH.test(enginePath)) return enginePath;
  if (/['\u0000-\u001f\u007f]/.test(enginePath)) return null;
  return `'${enginePath}'`;
}

/**
 * Whether a launch starts this adapter's engine. Any one sign is enough: the
 * engine id, the name of the resolved executable, or the first word of the
 * command. Read from what the launch runs, never from a capability block a
 * profile may not carry.
 * @param {{engineId?: string, enginePath?: (string|null), command?: string, identifiedAs?: (string|null)}} launch - The launch's facts;
 *   `identifiedAs` is the engine the launch site itself recognised, from the profile it holds.
 * @returns {boolean}
 */
function _launchesCodex(launch) {
  const first = typeof launch.command === 'string' ? launch.command.trim().split(/\s+/)[0] || '' : '';
  return launch.identifiedAs === ENGINE_BINARY
    || launch.engineId === ENGINE_BINARY
    || (typeof launch.enginePath === 'string' && path.basename(launch.enginePath) === ENGINE_BINARY)
    || path.basename(first) === ENGINE_BINARY;
}

/**
 * Read the arguments of a Codex command that should open with one exact
 * executable, and refuse any whose isolation flags cannot be told for
 * certain. Shared by the judgment of a launch about to start and the
 * judgment of a command a running pane was started with, so both read a
 * command by the same rules.
 * @param {string} command - The engine command, trimmed.
 * @param {string} word - The executable as one shell word (see {@link _shellWord}).
 * @param {string} enginePath - The executable's path, for the sentence.
 * @returns {{words: string[]} | {refusal: {reasonCode: string, reason: string}}}
 */
function _readArguments(command, word, enginePath) {
  const refusal = (reasonCode, reason) => ({ refusal: { reasonCode, reason } });
  if (!(command === word || command.startsWith(`${word} `))) {
    return refusal('command_not_pinned', `The launch command does not start with the Codex executable that was checked (${enginePath}), `
      + 'so a different Codex could be the one that runs.');
  }
  const rest = command.slice(word.length).trim();
  const words = rest === '' ? [] : rest.split(/\s+/);
  const odd = words.find((w) => !PLAIN_ARGUMENT.test(w));
  if (odd !== undefined) {
    return refusal('command_unparseable', `The Codex launch argument ${JSON.stringify(odd)} contains characters a shell may rewrite, so TangleClaw cannot tell which flags Codex would receive.`);
  }
  if (words.includes('--')) {
    return refusal('command_unparseable', 'The Codex launch arguments end option parsing with `--`, so an isolation flag after it would not be read as one.');
  }
  // One isolation flag, once, in its plain form. Two of them, both kinds
  // together, an `=` form or any flag that turns the shared process back on
  // leaves it to Codex's own parser which one wins, and that is not known here.
  const count = (flag) => words.filter((w) => w === flag).length;
  const ambiguous = count('--remote') > 1 || count('--no-daemon') > 1
    || (count('--remote') > 0 && count('--no-daemon') > 0)
    || words.some((w) => /^--(remote|no-daemon)=/.test(w) || /^--daemon/.test(w));
  if (ambiguous) {
    return refusal('command_unparseable', 'The Codex launch arguments repeat or contradict the flags that decide which Codex process serves the session, so TangleClaw cannot tell which one Codex would follow.');
  }
  return { words };
}

/**
 * The executable a recorded command opens with: a plain absolute path, or one
 * in the single quotes {@link _shellWord} writes. Null when the command opens
 * with anything else, a bare command name included.
 * @param {string} command - The engine command, trimmed.
 * @returns {{enginePath: string, word: string}|null}
 */
function _leadingExecutable(command) {
  const quoted = /^'([^']+)'(?=\s|$)/.exec(command);
  const enginePath = quoted ? quoted[1] : (command.split(/\s+/)[0] || '');
  const word = _shellWord(enginePath);
  if (!word || !(command === word || command.startsWith(`${word} `))) return null;
  return { enginePath, word };
}

/**
 * Judge the command a running pane was started with: was that session
 * positively kept off Codex's shared background process?
 *
 * The sibling of `lib/startup-control-codex.js#judgeLaunchCommand`, for a session that is already
 * running, and it does not inherit that judgment's footing. A launch is judged
 * with the executable TangleClaw resolved and a version probe taken for it.
 * Neither exists afterwards, so this reads only what was recorded at launch:
 * the command string tmux kept, and for a session attached to its own server,
 * the channel row written when that server started.
 *
 * `isolated` is answered for exactly two commands:
 * - the executable by absolute path, attached with `--remote` to the socket
 *   this session's own open channel records, started from that same
 *   executable on a version the profile records as verified for the channel;
 * - the executable by absolute path with `--no-daemon`. The version is not
 *   re-read: a probe now would describe the file on disk, not the process
 *   running. What stands in for it is that only the judged launch path writes
 *   a command that opens with the absolute path, and that path does not start
 *   a `--no-daemon` launch on an unverified version. A launch made before the
 *   judgment existed used the bare command name and is `not-isolated` here.
 *
 * Pure: it runs nothing and reads no cache.
 *
 * What it cannot see: the process now running in the pane, which may not be
 * the one the command started; and everything `lib/startup-control-codex.js#judgeLaunchCommand`
 * cannot see.
 * @param {object} input
 * @param {string} input.engineId - The session's engine id.
 * @param {string} input.command - The engine command the pane was started with, with TangleClaw's wrappers removed.
 * @param {string|null} [input.identifiedAs] - The engine the caller recognised this session as.
 * @param {{resolvedSocketPath?: string, enginePath?: string, engineVersion?: string}|null} [input.channel] - The state of this session's open channel, if it has one.
 * @param {string[]|null} [input.nativeVerifiedVersions] - The versions the engine profile records as verified for the native channel.
 * @returns {{applies: false} | {applies: true, verdict: 'isolated', basis: ('native-app-server'|'no-daemon'), reasonCode: null, reason: string} | {applies: true, verdict: 'not-isolated', basis: null, reasonCode: string, reason: string, startedUnisolatedByPath?: true}}
 *   `startedUnisolatedByPath` marks the command an overridden launch writes
 *   (`lib/startup-control-codex.js#judgeOverriddenLaunch`): the exact executable, plain arguments,
 *   and neither isolation flag. It is still `not-isolated`, and the flag
 *   describes the command only. It does not show the launch was overridden:
 *   a profile that names Codex by absolute path ran this same command before
 *   launches were judged. A reader needs the launch's own record for that.
 */
function judgeRecordedCommand(input) {
  const { engineId, identifiedAs, channel, nativeVerifiedVersions } = input || {};
  const command = input && typeof input.command === 'string' ? input.command.trim() : '';
  const first = command.split(/\s+/)[0] || '';
  const lead = _leadingExecutable(command);
  if (!_launchesCodex({ engineId, enginePath: lead ? lead.enginePath : null, command, identifiedAs })) return { applies: false };
  const not = (reasonCode, reason) => ({ applies: true, verdict: 'not-isolated', basis: null, reasonCode, reason });
  if (!lead) {
    return not('command_not_pinned', `This session was started with ${first ? `\`${first}\`` : 'no command'}, not with an exact Codex executable path. `
      + 'That is how Codex was started before TangleClaw checked launches, so nothing shows it was kept off Codex\'s shared background process.');
  }
  if (path.basename(lead.enginePath) !== ENGINE_BINARY) {
    return not('executable_unverified', `This session is a Codex session, but it was started with ${lead.enginePath}, which is not named \`codex\`. `
      + 'TangleClaw cannot tell that a wrapper passes the isolation flags on.');
  }
  const read = _readArguments(command, lead.word, lead.enginePath);
  if (read.refusal) return not(read.refusal.reasonCode, read.refusal.reason);
  const words = read.words;
  if (words.includes('--remote')) {
    const bound = channel && typeof channel.resolvedSocketPath === 'string' && channel.resolvedSocketPath !== ''
      && channel.enginePath === lead.enginePath
      && words[0] === '--remote' && words[1] === `unix://${channel.resolvedSocketPath}`;
    if (!bound) {
      return not('command_unisolated', channel
        ? 'This session was attached to a Codex server other than the one TangleClaw records for it.'
        : 'This session was attached to a Codex server, and TangleClaw has no open record of a server started for it.');
    }
    const verified = Array.isArray(nativeVerifiedVersions) ? nativeVerifiedVersions : [];
    if (typeof channel.engineVersion !== 'string' || !verified.includes(channel.engineVersion)) {
      return not('native_version_unverified', `The server this session is attached to was started as Codex ${channel.engineVersion || '(version unknown)'}, which is not a version TangleClaw has verified for attaching a session to its own server.`);
    }
    return {
      applies: true, verdict: 'isolated', basis: 'native-app-server', reasonCode: null,
      reason: `Started attached to its own Codex ${channel.engineVersion} server, which TangleClaw started for this session.`
    };
  }
  if (!words.includes('--no-daemon')) {
    return {
      ...not('command_unisolated', 'This session was started without `--no-daemon` and without a server of its own, so it uses Codex\'s shared background process.'),
      startedUnisolatedByPath: true
    };
  }
  return {
    applies: true, verdict: 'isolated', basis: 'no-daemon', reasonCode: null,
    reason: 'Started from an exact Codex executable with `--no-daemon`. The Codex version was checked when it was launched and is not checked again here.'
  };
}

/**
 * Take the PATH floor back off a pane command: the inverse of
 * `lib/sessions.js#_withPathFloor`, for any bin directory that function would accept.
 * A command that does not open with exactly that prefix is returned as it is.
 * @param {string} command - A pane command, as it was handed to tmux.
 * @returns {string}
 */
function _withoutPathFloor(command) {
  const floor = /^export PATH="([^"`$\\\n\r]*):\$PATH"; /.exec(typeof command === 'string' ? command : '');
  return floor ? command.slice(floor[0].length) : command;
}

module.exports = {
  judgeRecordedCommand,
  _withoutPathFloor,
  _shellWord,
  _launchesCodex,
  _readArguments,
  _leadingExecutable,
  SAFE_PATH,
  ENGINE_BINARY,
  PLAIN_ARGUMENT
};
