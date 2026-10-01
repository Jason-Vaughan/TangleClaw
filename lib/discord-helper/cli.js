'use strict';

/**
 * `tc-discord-helper`: the Discord helper's commands (#1799). `bin/tc-discord-helper`
 * only dispatches here, so every command runs in tests against injected fakes.
 *
 * Where things live, all under the operator's home and none in the repository:
 * - `~/.tangleclaw/discord-helper.json`: the non-secret config (TangleClaw's
 *   address and the allowlisted Discord ids). Written by `configure`.
 * - `~/.tangleclaw/discord-helper/`: the durable record of replies in flight
 *   (`state.json`), the running helper's last status (`status.json`) and its
 *   pid (`helper.pid`).
 * - The two secrets: the macOS Keychain only (`set-secret`).
 * - `~/Library/LaunchAgents/com.tangleclaw.discord-helper.plist`: paths and a
 *   label only (`install-launchd`).
 *
 * Nothing this module prints or writes holds a secret or a message body.
 *
 * Exit codes: 0 done · 1 usage, or refused as unsafe right now · 2 a check or
 * action failed · 78 the helper cannot start: its config, a secret, its record
 * or its lock is missing, invalid or cannot be written (launchd then waits its
 * throttle interval before trying again).
 *
 * @module lib/discord-helper/cli
 */

const fs = require('node:fs');
const path = require('node:path');

const { createLog } = require('./log');
const secretsModule = require('./secrets');
const { openState, peekState, StateError, StateWriteError } = require('./state');
const { createC1Client } = require('./c1-client');
const { createDiscordRest } = require('./discord-rest');
const { createGateway } = require('./gateway');
const { createInbound } = require('./inbound');
const { createOutbound } = require('./outbound');

const LABEL = 'com.tangleclaw.discord-helper';
const EXIT = Object.freeze({ OK: 0, USAGE: 1, FAILED: 2, CONFIG: 78 });
const SNOWFLAKE = /^\d{17,20}$/;
const STATUS_EVERY_MS = 15000;

const USAGE = `usage: tc-discord-helper <command>

  configure --base-url <url> --author <id> --guild <id> --channel <id> [--poll-seconds <n>]
                          write the non-secret config
  set-secret <bot|channel> store a secret in the Keychain, read from stdin
  verify                  check both tokens and post one test notification
  run                     run the helper (launchd runs this)
  status                  show what the helper is doing; never a secret or a message
  settle <outbound-id> --posted <discord-message-id> | --repost | --discard
                          settle a held reply, with the helper stopped:
                            uncertain: --posted <id> (that part did post) or --repost (it did not)
                            rejected:  --discard (Discord refused it; drop it, recorded as discarded)
  install-launchd [--no-load]   write the launchd job and load it
  uninstall-launchd       unload the launchd job and remove it`;

/**
 * The helper's file locations under a home directory.
 * @param {string} home - The operator's home directory
 * @returns {{config: string, dir: string, state: string, status: string, pid: string, plist: string, logDir: string}}
 */
function pathsFor(home) {
  const dir = path.join(home, '.tangleclaw', 'discord-helper');
  return {
    config: path.join(home, '.tangleclaw', 'discord-helper.json'),
    dir,
    state: path.join(dir, 'state.json'),
    status: path.join(dir, 'status.json'),
    pid: path.join(dir, 'helper.pid'),
    plist: path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`),
    logDir: path.join(home, '.tangleclaw', 'logs')
  };
}

/**
 * Parse `--name value` flags; a flag with no value is `true`.
 * @param {string[]} args - Arguments after the command
 * @returns {{flags: Object<string, (string|boolean)>, positional: string[]}}
 */
function parseArgs(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) { flags[a.slice(2)] = next; i++; } else flags[a.slice(2)] = true;
    } else positional.push(a);
  }
  return { flags, positional };
}

/**
 * Whether a value is an address the helper can reach TangleClaw at: one that
 * parses as an http or https URL with a host. It is parsed, not pattern-matched,
 * because the client parses it too and a value only a pattern accepts would
 * stop the helper at start. A URL carrying a user name or password is refused:
 * the client sends the channel token and nothing from the URL but its origin,
 * and `status` prints this value, which must never hold a secret.
 * @param {*} value - The configured `baseUrl`
 * @returns {boolean}
 */
function validBaseUrl(value) {
  if (typeof value !== 'string') return false;
  let url;
  try {
    url = new URL(value);
  // prawduct:allow prawduct/broad-except -- URL throws only for a value that is not a URL
  } catch {
    return false;
  }
  return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname !== '' && url.username === '' && url.password === '';
}

/**
 * Read and check the config.
 * @param {string} file - Config path
 * @returns {{baseUrl: string, allow: {authorId: string, guildId: string, channelId: string}, pollSeconds: number}}
 * @throws {Error} `config-missing` or `config-invalid`
 */
function loadConfig(file) {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(file, 'utf8'));
  // prawduct:allow prawduct/broad-except -- absent or unparsable is one answer: not configured
  } catch (err) {
    throw new Error(err && err.code === 'ENOENT' ? 'config-missing' : 'config-invalid');
  }
  const allow = cfg && cfg.allow;
  if (!cfg || !validBaseUrl(cfg.baseUrl) || !allow
    || !SNOWFLAKE.test(allow.authorId) || !SNOWFLAKE.test(allow.guildId) || !SNOWFLAKE.test(allow.channelId)
    || !(Number.isInteger(cfg.pollSeconds) && cfg.pollSeconds >= 5 && cfg.pollSeconds <= 300)) {
    throw new Error('config-invalid');
  }
  return cfg;
}

/**
 * Whether a process is alive.
 * @param {number} pid - Process id
 * @returns {boolean}
 */
function processAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  // prawduct:allow prawduct/broad-except -- ESRCH (gone) is the usual answer; EPERM means alive but not ours
  } catch (err) {
    return err && err.code === 'EPERM';
  }
}

/**
 * The pid of a running helper, if one is.
 * @param {string} pidFile - Pid file
 * @param {function(number): boolean} alive - Liveness check
 * @returns {number|null}
 */
function runningPid(pidFile, alive) {
  let pid;
  try { pid = Number(fs.readFileSync(pidFile, 'utf8').trim()); } catch { return null; } // prawduct:allow prawduct/broad-except -- no pid file: nothing running
  return Number.isInteger(pid) && pid > 0 && alive(pid) ? pid : null;
}

/**
 * Take the one-helper lock. The pid is written to a private file first and
 * then hard-linked into place, which fails if the lock exists, so the lock
 * file never exists without its pid: two helpers started at the same instant
 * cannot both win. A lock whose pid cannot be read is treated as held, never
 * as stale. A lock left by a helper that is no longer alive is taken over.
 *
 * One race remains: two helpers that find the same stale lock at the same
 * moment can both clear it and both take it. That needs a crashed helper and
 * then two starts at once by hand; launchd runs one job per label.
 * @param {string} pidFile - Pid file
 * @param {number} pid - This process
 * @param {function(number): boolean} alive - Liveness check
 * @returns {number|null} null when the lock is ours, else the holder's pid (-1 when unreadable)
 * @throws {Error} When the lock's files cannot be written or read (a full
 *   disk, permissions). Whether another helper runs is then unknown, so both
 *   callers answer it as `lock-failed` and go no further.
 */
function acquireLock(pidFile, pid, alive) {
  fs.mkdirSync(path.dirname(pidFile), { recursive: true, mode: 0o700 });
  const mine = `${pidFile}.${pid}.tmp`;
  try {
    // Inside the try: a write that fails part-way can still leave the file, and
    // each restart has a new pid, so they would pile up.
    fs.writeFileSync(mine, String(pid), { mode: 0o600 });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.linkSync(mine, pidFile);
        return null;
      } catch (err) {
        if (err.code !== 'EEXIST') throw err;
      }
      let holder;
      try {
        holder = Number(fs.readFileSync(pidFile, 'utf8').trim());
      } catch (err) {
        if (err.code === 'ENOENT') continue; // released between the two calls: try again
        throw err;
      }
      if (!Number.isInteger(holder) || holder <= 0) return -1;
      if (holder !== pid && alive(holder)) return holder;
      fs.rmSync(pidFile, { force: true });
    }
    return -1;
  } finally {
    fs.rmSync(mine, { force: true });
  }
}

/**
 * Release the one-helper lock, if this process holds it.
 * @param {string} pidFile - Pid file
 * @param {number} pid - This process
 * @returns {void}
 */
function releaseLock(pidFile, pid) {
  try {
    if (fs.readFileSync(pidFile, 'utf8').trim() === String(pid)) fs.rmSync(pidFile, { force: true });
  // prawduct:allow prawduct/broad-except -- no lock file, or an unreadable one: nothing of ours to release
  } catch { /* nothing to release */ }
}

/**
 * Write a file owner-only, atomically.
 * @param {string} file - Path
 * @param {string} text - Content
 * @returns {void}
 */
function writePrivate(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/**
 * Which part of a reply an entry stands at, for a reply posted as several
 * Discord messages: `, part 2 of 3`. Empty for a single message, and for an
 * entry that does not record how many parts there are.
 * @param {{parts?: string[], total?: number}} e - A record entry
 * @returns {string}
 */
function partNote(e) {
  return Number.isInteger(e.total) && e.total > 1 ? `, part ${(e.parts || []).length + 1} of ${e.total}` : '';
}

/**
 * One `status` line for a reply the record holds: its id and state, never its text.
 * @param {number} id - Outbound id
 * @param {{state: string, parts?: string[], total?: number}} e - Its record entry
 * @returns {string}
 */
function heldLine(id, e) {
  if (e.state === 'uncertain') return `reply ${id}: uncertain${partNote(e)} (settle it: see docs/discord-helper.md)`;
  if (e.state === 'rejected') return `reply ${id}: rejected${partNote(e)} (settle it: see docs/discord-helper.md)`;
  if (e.state === 'discarding') return `reply ${id}: discarding (the helper tells TangleClaw when it next runs)`;
  return `reply ${id}: ${e.state}`;
}

/**
 * What `settle` tells the operator once a settlement is recorded.
 * @param {number} id - Outbound id
 * @param {{state: string, partsPosted: number, total: (number|null)}} r - `settleHeld`'s result
 * @param {{postedId?: string, repost?: boolean, discard?: boolean}} how - What was asked
 * @returns {string}
 */
function settledLine(id, r, how) {
  const several = r.total !== null && r.total > 1;
  if (how.discard) {
    const kept = r.partsPosted > 0 ? ` Its first ${r.partsPosted} part(s) did post and stay in the channel.` : '';
    return `Reply ${id} is set to be discarded; when the helper next runs, TangleClaw drops its text and records it as discarded, not as delivered.${kept}`;
  }
  if (how.repost) {
    return several
      ? `Reply ${id} is now posting; the helper posts part ${r.partsPosted + 1} of ${r.total} again, then any parts after it, when it next runs.`
      : `Reply ${id} is now posting; the helper posts it again when it next runs.`;
  }
  if (r.state === 'posted') {
    return several
      ? `Reply ${id}: part ${r.partsPosted} of ${r.total} is recorded as posted, which completes it; the helper acknowledges it when it next runs.`
      : `Reply ${id} is now posted; the helper acknowledges it when it next runs.`;
  }
  return several
    ? `Reply ${id}: part ${r.partsPosted} of ${r.total} is recorded as posted; the helper posts the parts after it when it next runs.`
    : `Reply ${id}: that message is recorded as posted; the helper posts any part after it, then acknowledges the reply, when it next runs.`;
}

/**
 * What `settle` tells the operator when a settlement is refused. Nothing was changed.
 * @param {number} id - Outbound id
 * @param {{code?: string, held?: (string|null)}} err - What `settleHeld` threw
 * @returns {string|null} null for anything but a refusal this command has words for
 */
function refusedLine(id, err) {
  if (err.code === 'not-held') return `Reply ${id} is not held; nothing to settle.`;
  if (err.code === 'duplicate-part') return `That Discord message id is already recorded for an earlier part of reply ${id}. Nothing was settled.`;
  if (err.code === 'wrong-state' && err.held === 'rejected') {
    return `Reply ${id} is held as rejected: Discord refused it, so it did not post, and posting it again would be refused again. To drop it: settle ${id} --discard. Nothing was settled.`;
  }
  if (err.code === 'wrong-state') {
    return `Reply ${id} is held as uncertain: it may have posted. Look in the channel, then use --posted <discord-message-id> or --repost. Nothing was settled.`;
  }
  if (err.code === 'bad-id') return 'A Discord message id is digits only. Nothing was settled.';
  return null;
}

/**
 * Escape text for a plist string.
 * @param {string} s - Text
 * @returns {string}
 */
function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * The launchd job, from `deploy/com.tangleclaw.discord-helper.plist`. It holds
 * paths and a label only: the helper reads its secrets from the Keychain and
 * its ids from its own config.
 * @param {{template: string, nodePath: string, repoDir: string, home: string}} p - Values
 * @returns {string}
 */
function renderPlist({ template, nodePath, repoDir, home }) {
  return template
    .replace(/__NODE_PATH__/g, xmlEscape(nodePath))
    .replace(/__REPO_DIR__/g, xmlEscape(repoDir))
    .replace(/__HOME__/g, xmlEscape(home));
}

/**
 * Read one secret line from stdin. On a terminal it is read with echo off, a
 * key at a time, so the token is never shown; Ctrl-C abandons it.
 * @param {NodeJS.ReadableStream & {isTTY?: boolean, setRawMode?: Function}} stdin - Input
 * @returns {Promise<string>}
 */
function readStdin(stdin) {
  if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
    return new Promise((resolve, reject) => {
      let value = '';
      stdin.setRawMode(true);
      const done = (fn) => { stdin.setRawMode(false); stdin.removeListener('data', onData); if (typeof stdin.pause === 'function') stdin.pause(); fn(); };
      const onData = (chunk) => {
        for (const ch of String(chunk)) {
          if (ch === '\r' || ch === '\n' || ch === '\u0004') return done(() => resolve(value));
          if (ch === '\u0003') return done(() => reject(new Error('cancelled')));
          if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
          else value += ch;
        }
        return undefined;
      };
      stdin.on('data', onData);
      if (typeof stdin.resume === 'function') stdin.resume();
    });
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    stdin.on('data', (c) => chunks.push(Buffer.from(c)));
    stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '')));
    stdin.on('error', reject);
  });
}

/**
 * Run one command.
 * @param {string[]} argv - Arguments after the program name
 * @param {object} deps - Everything with a side effect
 * @param {string} deps.home - Home directory
 * @param {string} deps.repoDir - This checkout
 * @param {string} deps.nodePath - Node binary for the launchd job
 * @param {number} deps.uid - User id, for `launchctl` domains
 * @param {function(string): void} deps.out - Standard output line sink
 * @param {function(string): void} deps.errLine - Standard error line sink (the helper's log goes here)
 * @param {NodeJS.ReadableStream} deps.stdin - Standard input
 * @param {{readSecret: Function, storeSecret: Function}} [deps.secrets] - Keychain access
 * @param {Function} [deps.fetch] - fetch
 * @param {Function} [deps.WebSocket] - WebSocket constructor
 * @param {function(string[]): Promise<number>} deps.launchctl - Runs launchctl, resolves its exit code
 * @param {function(number): boolean} [deps.alive] - Process liveness
 * @param {number} [deps.pid] - This process's pid
 * @param {function(function(): void): void} [deps.onStop] - Registers the stop handler (SIGTERM/SIGINT)
 * @param {function(): number} [deps.now] - Clock, ms
 * @returns {Promise<number>} Exit code
 */
async function main(argv, deps) {
  const [command, ...rest] = argv;
  const { flags, positional } = parseArgs(rest);
  const p = pathsFor(deps.home);
  const secrets = deps.secrets || secretsModule;
  const alive = deps.alive || processAlive;
  const now = deps.now || Date.now;
  const { log } = createLog({ write: deps.errLine, now: () => new Date(now()) });

  switch (command) {
    case 'configure': {
      const cfg = {
        baseUrl: flags['base-url'],
        allow: { authorId: flags.author, guildId: flags.guild, channelId: flags.channel },
        pollSeconds: flags['poll-seconds'] === undefined ? 15 : Number(flags['poll-seconds'])
      };
      const tmp = `${p.config}.check`;
      writePrivate(tmp, JSON.stringify(cfg, null, 2));
      try {
        loadConfig(tmp);
      // prawduct:allow prawduct/broad-except -- loadConfig answers only with config-invalid here
      } catch {
        fs.rmSync(tmp, { force: true });
        deps.out('Not written: --base-url must be an http:// or https:// URL with a host and no user name or password, --author, --guild and --channel must be Discord ids (17-20 digits), and --poll-seconds 5-300.');
        return EXIT.USAGE;
      }
      fs.renameSync(tmp, p.config);
      deps.out(`Wrote ${p.config}`);
      return EXIT.OK;
    }

    case 'set-secret': {
      const name = positional[0];
      if (name !== 'bot' && name !== 'channel') { deps.out(USAGE); return EXIT.USAGE; }
      if (deps.stdin.isTTY) deps.out(`Paste the ${name === 'bot' ? 'Discord bot' : 'operator-channel'} token and press Enter (it is not shown).`);
      let value;
      try {
        value = await readStdin(deps.stdin);
      // prawduct:allow prawduct/broad-except -- the only rejection is Ctrl-C or a closed stdin
      } catch {
        deps.out('Cancelled; nothing stored.');
        return EXIT.USAGE;
      }
      try {
        await secrets.storeSecret(name, value);
        // Read it back: the store's exit status is `security`'s word, and this is proof.
        if ((await secrets.readSecret(name)) !== value) throw Object.assign(new Error('secret-store-failed'), { code: 'secret-store-failed' });
      // prawduct:allow prawduct/broad-except -- storeSecret and readSecret answer only with closed-code errors
      } catch {
        // A value that did not store, or that cannot be read back, is not stored.
        log('secret-store-failed');
        deps.out('Not stored. A token is letters, digits, ".", "_" and "-" only; check it and try again.');
        return EXIT.FAILED;
      }
      deps.out(`Stored the ${name} secret in the Keychain.`);
      return EXIT.OK;
    }

    case 'status': {
      const lines = [];
      let cfg = null;
      try { cfg = loadConfig(p.config); } catch (err) { lines.push(`config: ${err.message}`); } // prawduct:allow prawduct/broad-except -- reported as its closed code
      if (cfg) lines.push(`config: ok; TangleClaw ${cfg.baseUrl}; author ${cfg.allow.authorId}, guild ${cfg.allow.guildId}, channel ${cfg.allow.channelId}`);
      for (const name of ['bot', 'channel']) {
        try {
          await secrets.readSecret(name);
          lines.push(`secret ${name}: present`);
        // prawduct:allow prawduct/broad-except -- reported as its closed code
        } catch (err) {
          lines.push(`secret ${name}: ${err && err.code ? err.code : 'secret-read-failed'}`);
        }
      }
      const pid = runningPid(p.pid, alive);
      lines.push(pid ? `helper: running (pid ${pid})` : 'helper: not running');
      let snap = null;
      try { snap = JSON.parse(fs.readFileSync(p.status, 'utf8')); } catch { /* prawduct:allow prawduct/broad-except -- no snapshot yet */ }
      const wellFormed = snap && snap.gateway && typeof snap.gateway.state === 'string'
        && snap.outbound && typeof snap.at === 'string';
      if (pid && snap && !wellFormed) lines.push('status snapshot: unreadable; the helper rewrites it within 15 s');
      if (wellFormed && pid) {
        lines.push(`gateway: ${snap.gateway.state}${snap.gateway.fatalCloseCode ? ` (Discord closed with ${snap.gateway.fatalCloseCode}; see docs/discord-helper.md)` : ''}`);
        lines.push(`last poll of TangleClaw: ${snap.outbound.lastPollAt || 'none yet'}; snapshot ${Math.round((now() - Date.parse(snap.at)) / 1000)}s old`);
      }
      let held = [];
      try { held = peekState(p.state).filter(([, e]) => e.state !== 'posted'); } catch (err) { lines.push(`state: ${err.code || 'state-unreadable'}`); } // prawduct:allow prawduct/broad-except -- reported as its closed code
      for (const [id, e] of held) lines.push(heldLine(id, e));
      if (held.length === 0) lines.push('replies held: none');
      for (const l of lines) deps.out(l);
      return EXIT.OK;
    }

    case 'verify': {
      let cfg;
      let bot;
      let chan;
      try {
        cfg = loadConfig(p.config);
        bot = await secrets.readSecret('bot');
        chan = await secrets.readSecret('channel');
      // prawduct:allow prawduct/broad-except -- each answer is a closed code, printed as such
      } catch (err) {
        deps.out(`Cannot verify: ${err.code || err.message}`);
        return EXIT.CONFIG;
      }
      const c1 = createC1Client({ baseUrl: cfg.baseUrl, token: chan, fetch: deps.fetch });
      const rest = createDiscordRest({ token: bot, fetch: deps.fetch });
      try {
        const waiting = await c1.listOutbound();
        deps.out(`TangleClaw: the channel token works; ${waiting.length} item(s) waiting.`);
      // prawduct:allow prawduct/broad-except -- a C1Error, reported by status and code
      } catch (err) {
        deps.out(`TangleClaw: refused or unreachable (${err.status || 'no answer'}${err.refusalCode ? ` ${err.refusalCode}` : ''}).`);
        return EXIT.FAILED;
      }
      try {
        const posted = await rest.createMessage(cfg.allow.channelId, {
          content: '\u{1F514} **TangleClaw: Helper check**\nThe Discord helper can post here. Reply to this channel to talk to the configured project.',
          nonce: `v${now()}`.slice(0, 25)
        });
        deps.out(`Discord: posted a test notification (message ${posted.id}).`);
      // prawduct:allow prawduct/broad-except -- a DiscordError, reported by status and code
      } catch (err) {
        deps.out(`Discord: the post failed (${err.status || 'no answer'}${err.discordCode ? ` code ${err.discordCode}` : ''}).`);
        return EXIT.FAILED;
      }
      deps.out('Round trip: with the helper running, send a message in the channel. Expect a ✅ reaction, then the project\'s reply.');
      return EXIT.OK;
    }

    case 'settle': {
      const id = Number(positional[0]);
      // Exactly one finding: two would contradict each other.
      const asked = ['posted', 'repost', 'discard'].filter((f) => flags[f] !== undefined);
      const how = asked.length !== 1 ? null
        : typeof flags.posted === 'string' ? { postedId: flags.posted }
          : flags.repost === true ? { repost: true }
            : flags.discard === true ? { discard: true } : null;
      if (!Number.isInteger(id) || id < 1 || !how) { deps.out(USAGE); return EXIT.USAGE; }
      // The record has one writer at a time: take the same lock the helper does.
      let holder;
      try {
        holder = acquireLock(p.pid, deps.pid, alive);
      // prawduct:allow prawduct/broad-except -- any failed file call of the lock is one answer, a closed code; fs's own message names paths
      } catch {
        log('lock-failed');
        deps.out(`Cannot take the helper's lock (lock-failed): check that ${p.dir} can be written. Nothing was settled.`);
        return EXIT.FAILED;
      }
      if (holder) {
        deps.out(`The helper is running${holder > 0 ? ` (pid ${holder})` : ''}. Stop it first, so it cannot overwrite the record: launchctl bootout gui/${deps.uid}/${LABEL}`);
        return EXIT.USAGE;
      }
      try {
        /**
         * Say that the record could not be written, in the log and to the operator.
         * @returns {number} Exit code
         */
        const unwritten = () => {
          log('state-write-failed');
          deps.out(`Cannot write the record (state-write-failed): check that ${p.dir} can be written. Nothing was settled.`);
          return EXIT.FAILED;
        };
        let state;
        try {
          state = openState(p.state);
        // prawduct:allow prawduct/broad-except -- a StateError or a StateWriteError, reported as its closed code
        } catch (err) {
          if (err instanceof StateWriteError) return unwritten();
          deps.out(`Cannot read the record: ${err.code || 'state-unreadable'}`);
          return EXIT.FAILED;
        }
        // Only settleHeld is called, which touches the record and neither client.
        const relay = createOutbound({ c1: {}, rest: {}, state, channelId: '0', log });
        try {
          deps.out(settledLine(id, relay.settleHeld(id, how), how));
          return EXIT.OK;
        // prawduct:allow prawduct/broad-except -- a StateWriteError or a refusal with words of its own is answered; anything else is rethrown
        } catch (err) {
          if (err instanceof StateWriteError) return unwritten();
          const refusal = refusedLine(id, err);
          if (refusal === null) throw err;
          deps.out(refusal);
          return EXIT.USAGE;
        }
      } finally {
        releaseLock(p.pid, deps.pid);
      }
    }

    case 'install-launchd': {
      const template = fs.readFileSync(path.join(deps.repoDir, 'deploy', `${LABEL}.plist`), 'utf8');
      fs.mkdirSync(p.logDir, { recursive: true, mode: 0o700 });
      fs.mkdirSync(path.dirname(p.plist), { recursive: true });
      fs.writeFileSync(p.plist, renderPlist({ template, nodePath: deps.nodePath, repoDir: deps.repoDir, home: deps.home }), { mode: 0o644 });
      deps.out(`Wrote ${p.plist}`);
      if (flags['no-load'] === true) return EXIT.OK;
      await deps.launchctl(['bootout', `gui/${deps.uid}/${LABEL}`]);
      const code = await deps.launchctl(['bootstrap', `gui/${deps.uid}`, p.plist]);
      deps.out(code === 0 ? 'Loaded; launchd keeps the helper running.' : `launchctl bootstrap exited ${code}.`);
      return code === 0 ? EXIT.OK : EXIT.FAILED;
    }

    case 'uninstall-launchd': {
      await deps.launchctl(['bootout', `gui/${deps.uid}/${LABEL}`]);
      fs.rmSync(p.plist, { force: true });
      deps.out(`Unloaded and removed ${p.plist}. The Keychain items and ${p.dir} are kept.`);
      return EXIT.OK;
    }

    case 'run':
      return run(deps, p, secrets, alive, log, now);

    default:
      deps.out(USAGE);
      return EXIT.USAGE;
  }
}

/**
 * Run the helper until stopped.
 * @param {object} deps - As for `main`
 * @param {object} p - `pathsFor(home)`
 * @param {{readSecret: Function}} secrets - Keychain access
 * @param {function(number): boolean} alive - Process liveness
 * @param {function(string, object=): void} log - Closed-code log
 * @param {function(): number} now - Clock
 * @returns {Promise<number>} Exit code
 */
async function run(deps, p, secrets, alive, log, now) {
  let cfg;
  try {
    cfg = loadConfig(p.config);
  // prawduct:allow prawduct/broad-except -- config-missing or config-invalid, logged by code
  } catch (err) {
    log(err.message === 'config-missing' ? 'config-missing' : 'config-invalid');
    return EXIT.CONFIG;
  }
  // The lock comes before the record is opened: opening writes it, and a
  // second helper must never write the running one's record.
  let other;
  try {
    other = acquireLock(p.pid, deps.pid, alive);
  // prawduct:allow prawduct/broad-except -- any failed file call of the lock is one answer, a closed code; fs's own message names paths
  } catch {
    log('lock-failed');
    return EXIT.CONFIG;
  }
  if (other) {
    // Two helpers would each post every reply.
    log('helper-already-running', { pid: other });
    return EXIT.USAGE;
  }
  let state;
  let bot;
  let chan;
  try {
    state = openState(p.state);
    bot = await secrets.readSecret('bot');
    chan = await secrets.readSecret('channel');
  // prawduct:allow prawduct/broad-except -- a StateError, a StateWriteError or a SecretError, logged by its closed code; anything else is rethrown
  } catch (err) {
    releaseLock(p.pid, deps.pid);
    if (err instanceof StateError) log('state-unreadable');
    else if (err instanceof StateWriteError) log('state-write-failed');
    else if (err && (err.code === 'secret-missing' || err.code === 'secret-read-failed')) log(err.code, { secret: err.secretName });
    else throw err;
    return EXIT.CONFIG;
  }
  log('helper-start');

  const rest = createDiscordRest({ token: bot, fetch: deps.fetch, onRateLimited: (waitMs) => log('discord-rate-limited', { waitMs }) });
  const c1 = createC1Client({ baseUrl: cfg.baseUrl, token: chan, fetch: deps.fetch });
  const handle = createInbound({ allow: cfg.allow, c1, rest, log });
  const gateway = createGateway({ token: bot, WebSocket: deps.WebSocket, onMessageCreate: handle, log, getUrl: () => rest.getGatewayUrl() });
  const out = createOutbound({ c1, rest, state, channelId: cfg.allow.channelId, log, intervalMs: cfg.pollSeconds * 1000 });

  /** @returns {void} */
  const snapshot = () => {
    try {
      writePrivate(p.status, JSON.stringify({ at: new Date(now()).toISOString(), pid: deps.pid, gateway: gateway.status(), outbound: out.status() }));
    // prawduct:allow prawduct/broad-except -- status is a convenience; failing to write it must not stop the relay
    } catch {
      log('status-write-failed');
    }
  };

  gateway.start();
  out.start();
  snapshot();
  const timer = setInterval(snapshot, STATUS_EVERY_MS);
  if (typeof timer.unref === 'function') timer.unref();

  return new Promise((resolve) => {
    deps.onStop(() => {
      clearInterval(timer);
      gateway.stop();
      out.stop();
      snapshot();
      releaseLock(p.pid, deps.pid);
      log('helper-stop');
      resolve(EXIT.OK);
    });
  });
}

module.exports = { main, pathsFor, parseArgs, loadConfig, renderPlist, runningPid, LABEL, EXIT, USAGE };
