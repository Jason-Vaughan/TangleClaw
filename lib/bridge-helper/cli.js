'use strict';

/**
 * The bridge helper's commands (#2031): `configure`, `set-secret`, `preflight`, `run`,
 * `status`, `settle`, `install-launchd` and `uninstall-launchd`.
 *
 * Everything that touches the real machine arrives through `env`: the home
 * directory, the Keychain, the network, `launchctl`, standard input and the
 * stop signal. `bin/tc-bridge-helper` supplies the real ones; a test supplies
 * its own. No command prints a secret, a message's text or a Discord id.
 *
 * @module lib/bridge-helper/cli
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createLog } = require('./log');
const { ConfigError, paths, readConfig, writeConfig } = require('./config');
const secrets = require('./secrets');
const { openState, peekState } = require('./state');
const { createBridgeClient } = require('./bridge-client');
const { createDiscordRest } = require('./discord-rest');
const { createGateway } = require('./discord-gateway');
const { createInbound } = require('./inbound');
const { createOutbound, settleHeld, SettleError } = require('./outbound');

const LABEL = 'com.tangleclaw.bridge-helper';

/** Exit statuses: done, failed, misused, and not set up (sysexits' EX_CONFIG, which launchd's throttle spaces out). */
const EXIT = Object.freeze({ ok: 0, failed: 1, usage: 2, config: 78 });

/** The longest the helper waits between passes when the bridge or Discord is not answering. */
const BACKOFF_MAX_MS = 5 * 60 * 1000;

const USAGE = [
  'usage: tc-bridge-helper <command>',
  '  configure --base-url <url> --author <id> --guild <id> --channel <id> [--poll-seconds <n>]',
  '  set-secret <bot|helper>      read a token from standard input into the Keychain',
  '  preflight                    check everything that can be checked without posting or claiming',
  '  run                          relay until stopped',
  '  status                       show how the helper is set up and what it holds',
  '  settle <id> --posted <discord message id> | --repost',
  '  install-launchd [--no-load]',
  '  uninstall-launchd'
].join('\n');

/**
 * Parse `--name value` pairs and bare flags.
 * @param {string[]} args - Arguments after the command.
 * @param {string[]} valued - Options that take a value.
 * @param {string[]} flags - Options that take none.
 * @returns {{options: object, rest: string[]}|null} Null when an option is unknown or lacks its value.
 */
function parseOptions(args, valued, flags) {
  const options = {};
  const rest = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('--')) { rest.push(arg); continue; }
    const name = arg.slice(2);
    if (flags.includes(name)) { options[name] = true; continue; }
    if (!valued.includes(name) || i + 1 >= args.length) return null;
    options[name] = args[++i];
  }
  return { options, rest };
}

/**
 * Process seam, so a test can make `ps` fail.
 * @type {{execFileSync: Function}}
 */
const _internal = { execFileSync };

/**
 * Whether a pid is a running helper. A live process is not enough: after an
 * unclean exit the pid in the lock file can be reused by something else, and
 * a lock that trusted it would keep every later helper from starting.
 * @param {number} pid - Process id.
 * @returns {boolean}
 */
function isAlive(pid) {
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err.code !== 'EPERM') return false;
  }
  try {
    return _internal.execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8', timeout: 5000 }).includes('tc-bridge-helper');
  } catch (err) { // prawduct:allow prawduct/broad-except -- every way ps can fail is answered: gone, or not known
    // `ps` exits 1 when there is no such process. Any other failure leaves
    // the question open, and an open question is answered as "a helper may
    // be running": two helpers would post every item twice.
    return !(err && err.status === 1);
  }
}

/**
 * Take the one-helper lock. Two helpers would post every item twice.
 * @param {string} file - The lock file.
 * @param {number} pid - This process.
 * @param {function(number): boolean} alive - Whether a pid is a live process.
 * @returns {{held: true, release: function(): void}|{held: false, pid: number}} `pid` is -1 when the lock file is unreadable.
 * @throws {Error} When the lock file cannot be written.
 */
function takeLock(file, pid, alive) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, `${pid}\n`, { flag: 'wx', mode: 0o600 });
      return { held: true, release: () => { try { fs.rmSync(file, { force: true }); } catch { /* removed already */ } } };
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
    }
    const owner = Number(fs.readFileSync(file, 'utf8').trim());
    if (!Number.isInteger(owner) || owner <= 0) return { held: false, pid: -1 };
    if (alive(owner)) return { held: false, pid: owner };
    // Left by a helper that is gone.
    fs.rmSync(file, { force: true });
  }
  return { held: false, pid: -1 };
}

/**
 * Read all of standard input, with echo off when it is a terminal.
 * @param {object} stdin - A readable stream, possibly a TTY.
 * @returns {Promise<string>} What was entered, without its line ending.
 */
function readHidden(stdin) {
  return new Promise((resolve, reject) => {
    const tty = stdin.isTTY && typeof stdin.setRawMode === 'function';
    let text = '';
    const done = (fn, value) => {
      if (tty) stdin.setRawMode(false);
      stdin.pause();
      stdin.removeAllListeners('data');
      fn(value);
    };
    if (tty) stdin.setRawMode(true);
    stdin.setEncoding('utf8');
    stdin.on('data', (chunk) => {
      for (const ch of chunk) {
        if (tty && ch === '\u0003') return done(reject, new Error('interrupted'));
        if (tty && (ch === '\r' || ch === '\n')) return done(resolve, text);
        if (tty && (ch === '\u007f' || ch === '\b')) text = text.slice(0, -1);
        else text += ch;
      }
    });
    stdin.on('end', () => done(resolve, text.replace(/\r?\n$/, '')));
    stdin.on('error', (err) => done(reject, err));
    stdin.resume();
  });
}

/**
 * `configure`: write the helper's config.
 * @param {string[]} args - Arguments.
 * @param {object} env - The process seams.
 * @returns {number} Exit status.
 */
function configure(args, env) {
  const parsed = parseOptions(args, ['base-url', 'author', 'guild', 'channel', 'poll-seconds'], []);
  if (!parsed || parsed.rest.length) { env.errLine(USAGE); return EXIT.usage; }
  const o = parsed.options;
  const candidate = { baseUrl: o['base-url'], authorId: o.author, guildId: o.guild, channelId: o.channel };
  if (o['poll-seconds'] !== undefined) candidate.pollSeconds = /^\d+$/.test(o['poll-seconds']) ? Number(o['poll-seconds']) : NaN;
  try {
    writeConfig(paths(env.home).config, candidate);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    env.errLine(`Not written: ${err.field} is missing or not usable.`);
    return EXIT.usage;
  }
  env.out('Config written.');
  return EXIT.ok;
}

/**
 * `set-secret`: read a token from standard input and store it in the Keychain.
 * @param {string[]} args - Arguments.
 * @param {object} env - The process seams.
 * @returns {Promise<number>} Exit status.
 */
async function setSecret(args, env) {
  const name = args[0];
  if (args.length !== 1 || !Object.prototype.hasOwnProperty.call(secrets.SECRETS, name)) { env.errLine(USAGE); return EXIT.usage; }
  if (env.stdin.isTTY) env.errLine(`Paste the ${name} token and press Return. It is not shown.`);
  let value;
  try {
    value = (await readHidden(env.stdin)).trim();
  } catch {
    env.errLine('Nothing stored.');
    return EXIT.failed;
  }
  try {
    await env.secrets.storeSecret(name, value);
    if (await env.secrets.readSecret(name) !== value) throw new secrets.SecretError('secret-store-failed', name);
  } catch (err) {
    if (!(err instanceof secrets.SecretError)) throw err;
    env.errLine(err.code === 'secret-malformed' ? `Nothing stored: that is not the shape of a ${name} token.` : `Nothing stored: ${err.code}.`);
    return EXIT.failed;
  }
  env.out(`Stored the ${name} token in the Keychain.`);
  return EXIT.ok;
}

/**
 * Write the status snapshot `status` reads. Best effort: a snapshot that
 * cannot be written is logged and changes nothing else.
 * @param {string} file - The snapshot file.
 * @param {object} snapshot - Ids, numbers and states only.
 * @param {function(string, object=): void} log - Closed-code log.
 * @returns {void}
 */
function writeSnapshot(file, snapshot, log) {
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(snapshot), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch { // prawduct:allow prawduct/broad-except -- the snapshot is a convenience; any failure is one closed code
    log('status-write-failed');
  }
}

/**
 * `run`: relay until stopped.
 * @param {object} env - The process seams.
 * @returns {Promise<number>} Exit status.
 */
async function run(env) {
  const log = createLog({ write: env.errLine });
  const where = paths(env.home);
  let config;
  let tokens;
  let state;
  try {
    config = readConfig(where.config);
    tokens = { bot: await env.secrets.readSecret('bot'), helper: await env.secrets.readSecret('helper') };
    state = openState(where.state);
  } catch (err) {
    if (!err || typeof err.code !== 'string') throw err;
    log(err.code === 'secret-malformed' ? 'secret-read-failed' : err.code);
    return EXIT.config;
  }
  let lock;
  try {
    lock = takeLock(where.lock, env.pid, env.isAlive || isAlive);
  } catch { // prawduct:allow prawduct/broad-except -- any failure to take the lock is one closed code; fs's own message names paths
    log('lock-failed');
    return EXIT.config;
  }
  if (!lock.held) {
    log('helper-already-running', { pid: lock.pid });
    return EXIT.config;
  }

  const sleep = env.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const rest = createDiscordRest({ token: tokens.bot, fetch: env.fetch, api: env.discordApi, sleep, log });
  const bridge = createBridgeClient({ origin: config.baseUrl, token: tokens.helper, fetch: env.fetch });
  const gateway = createGateway({
    token: tokens.bot, log, WebSocket: env.WebSocket, getUrl: () => rest.getGatewayUrl(),
    onMessageCreate: createInbound({ allow: config, bridge, rest, log, sleep })
  });
  const outbound = createOutbound({ channelId: config.channelId, bridge, rest, state, log, gatewayStatus: gateway.status });

  let stopped = false;
  const timers = env.timers || globalThis;
  let wake = () => {};
  env.onStop(() => { stopped = true; wake(); });
  log('helper-start');
  gateway.start();
  let delay = config.pollSeconds * 1000;
  while (!stopped) {
    const pass = await outbound.pass();
    delay = pass.ok ? config.pollSeconds * 1000 : Math.min(delay * 2, BACKOFF_MAX_MS);
    writeSnapshot(where.status, { pid: env.pid, at: new Date().toISOString(), gateway: gateway.status(), lastPassOk: pass.ok, held: pass.held }, log);
    if (stopped) break;
    // The wait ends when its time is up or the helper is told to stop, and a
    // stop cancels the timer, so nothing keeps the process alive after it.
    await new Promise((resolve) => {
      const timer = timers.setTimeout(resolve, delay);
      wake = () => { timers.clearTimeout(timer); resolve(); };
    });
  }
  gateway.stop();
  lock.release();
  log('helper-stop');
  return EXIT.ok;
}

/**
 * `preflight`: everything that can be proven before the helper is started,
 * without posting, claiming or changing anything anywhere. One line per check,
 * each `ok`, `FAIL` or `unproven`, by a closed name; no secret and no id is
 * printed. It fails if any check fails. A check that cannot be made without
 * posting says `unproven` and does not count as passed or failed.
 * @param {object} env - The process seams.
 * @returns {Promise<number>} Exit status.
 */
async function preflight(env) {
  const where = paths(env.home);
  const results = [];
  const say = (name, verdict, note) => {
    results.push(verdict);
    env.out(`${verdict.padEnd(8)} ${name}${note ? `: ${note}` : ''}`);
  };
  /**
   * Run one check, turning any typed failure into a closed word.
   * @param {string} name - The check's name.
   * @param {function(): Promise<(string|true)>} check - Resolves true, or a closed reason for failing.
   * @returns {Promise<boolean>} Whether it passed.
   */
  const check = async (name, run) => {
    let verdict;
    try {
      verdict = await run();
    } catch (err) { // prawduct:allow prawduct/broad-except -- every check failure is reported by a closed code or its HTTP status, never its message
      verdict = err && typeof err.code === 'string' ? err.code : `status-${Number(err && err.status) || 0}`;
    }
    say(name, verdict === true ? 'ok' : 'FAIL', verdict === true ? '' : verdict);
    return verdict === true;
  };

  let config = null;
  await check('config', async () => { config = readConfig(where.config); return true; });
  const tokens = {};
  for (const name of Object.keys(secrets.SECRETS)) {
    await check(`secret-${name}`, async () => { tokens[name] = await env.secrets.readSecret(name); return true; });
  }
  await check('state-file', async () => {
    const mode = (file) => { try { return fs.statSync(file).mode & 0o777; } catch (err) { if (err.code === 'ENOENT') return null; throw err; } };
    const dir = mode(where.dir);
    const file = mode(where.state);
    if (dir !== null && dir !== 0o700) return 'directory-not-owner-only';
    if (file !== null && file !== 0o600) return 'file-not-owner-only';
    if (file !== null) peekState(where.state);
    return true;
  });
  await check('lock-free', async () => {
    let pid = null;
    try { pid = Number(fs.readFileSync(where.lock, 'utf8').trim()); } catch { pid = null; }
    return Number.isInteger(pid) && pid > 0 && (env.isAlive || isAlive)(pid) ? 'helper-already-running' : true;
  });

  if (config && tokens.helper) {
    let answer = null;
    const bridge = createBridgeClient({ origin: config.baseUrl, token: tokens.helper, fetch: env.fetch });
    if (await check('bridge-token', async () => { answer = await bridge.preflight({ authorId: config.authorId, spaceId: config.guildId, channelId: config.channelId }); return answer.tokenLive === true ? true : 'token-not-live'; })) {
      await check('bridge-allowlist', async () => (!answer.allowlistSet ? 'allowlist-not-set' : (answer.allowlistMatch ? true : 'allowlist-differs')));
      await check('bridge-circuit', async () => (answer.circuit === 'closed' ? true : 'configuration-circuit-open'));
      say('bridge-enabled', answer.bridgeEnabled ? 'ok' : 'unproven', answer.bridgeEnabled ? '' : 'not enabled yet; the operator enables it after preflight');
    }
  }
  if (config && tokens.bot) {
    const rest = createDiscordRest({ token: tokens.bot, fetch: env.fetch, api: env.discordApi, sleep: env.sleep });
    await check('discord-token', async () => ((await rest.getSelf()).bot ? true : 'not-a-bot-token'));
    await check('discord-channel', async () => ((await rest.getChannel(config.channelId)).guildId === config.guildId ? true : 'channel-not-in-server'));
    // Whether the bot may post there cannot be read without posting. It is proven by the first controlled post.
    say('discord-post', 'unproven', 'proven only by a post');
  }
  const failed = results.filter((v) => v === 'FAIL').length;
  env.out(failed ? `${failed} check(s) failed.` : 'No check failed. Checks marked unproven are proven by the first controlled message.');
  return failed ? EXIT.failed : EXIT.ok;
}

/**
 * `status`: how the helper is set up and what it holds. Never a secret, a
 * message's text or a Discord id.
 * @param {object} env - The process seams.
 * @returns {Promise<number>} Exit status.
 */
async function status(env) {
  const where = paths(env.home);
  try {
    const config = readConfig(where.config);
    env.out(`config: set (TangleClaw at ${config.baseUrl}, every ${config.pollSeconds}s)`);
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    env.out(`config: ${err.code === 'config-missing' ? 'not set; run configure' : 'not valid; run configure'}`);
  }
  for (const name of Object.keys(secrets.SECRETS)) {
    let state = 'present';
    try {
      await env.secrets.readSecret(name);
    } catch (err) {
      if (!(err instanceof secrets.SecretError)) throw err;
      state = { 'secret-missing': 'missing; run set-secret', 'secret-malformed': 'not the shape of a token; run set-secret' }[err.code] || 'could not be read';
    }
    env.out(`${name} token: ${state}`);
  }
  let pid = null;
  try { pid = Number(fs.readFileSync(where.lock, 'utf8').trim()); } catch { pid = null; }
  const running = Number.isInteger(pid) && pid > 0 && (env.isAlive || isAlive)(pid);
  env.out(`helper: ${running ? `running (pid ${pid})` : 'not running'}`);
  if (running) {
    try {
      const snapshot = JSON.parse(fs.readFileSync(where.status, 'utf8'));
      const gateway = snapshot.gateway || {};
      env.out(`gateway: ${String(gateway.state)}${gateway.fatalCloseCode ? ` (close code ${Number(gateway.fatalCloseCode)})` : ''}`);
      env.out(`last pass: ${String(snapshot.at)}, ${snapshot.lastPassOk ? 'ok' : 'failed; backing off'}`);
    } catch {
      env.out('gateway: no snapshot yet');
    }
  }
  let entries;
  try {
    entries = peekState(where.state);
  } catch {
    env.out('held: the record of posts in progress cannot be read (state-unreadable)');
    return EXIT.failed;
  }
  const held = entries.filter(([, entry]) => entry.status === 'uncertain');
  const moving = entries.length - held.length;
  if (moving) env.out(`in progress: ${moving} item${moving === 1 ? '' : 's'} posting or awaiting acknowledgement`);
  if (!held.length) env.out('held: nothing');
  for (const [id, entry] of held) {
    env.out(`item ${id}: ${entry.status}, part ${entry.parts.length + 1} (settle it: see docs/operator-bridge-helper.md)`);
  }
  return EXIT.ok;
}

/**
 * `settle`: record what the operator saw in the channel for a held item.
 * @param {string[]} args - Arguments.
 * @param {object} env - The process seams.
 * @returns {number} Exit status.
 */
function settle(args, env) {
  const parsed = parseOptions(args, ['posted'], ['repost']);
  if (!parsed || parsed.rest.length !== 1 || !/^\d{1,12}$/.test(parsed.rest[0])) { env.errLine(USAGE); return EXIT.usage; }
  const where = paths(env.home);
  let lock;
  try {
    lock = takeLock(where.lock, env.pid, env.isAlive || isAlive);
  } catch { // prawduct:allow prawduct/broad-except -- any failure to take the lock is one answer
    env.errLine('Nothing settled: the lock could not be taken (lock-failed).');
    return EXIT.failed;
  }
  if (!lock.held) {
    env.errLine('Nothing settled: stop the helper first.');
    return EXIT.failed;
  }
  try {
    const state = openState(where.state);
    const after = settleHeld(state, Number(parsed.rest[0]), { posted: parsed.options.posted, repost: parsed.options.repost });
    env.out(`Settled. Item ${parsed.rest[0]} carries on from part ${after.part} once the Project Master has put it back (tc bridge requeue ${parsed.rest[0]}).`);
    return EXIT.ok;
  } catch (err) {
    if (err instanceof SettleError) {
      env.errLine(`Nothing settled: ${{
        'not-held': 'that item is not held.',
        'duplicate-part': 'that message id is already recorded for an earlier part.',
        'bad-id': 'that is not a Discord message id.',
        'bad-settlement': 'give exactly one of --posted <id> and --repost.'
      }[err.code]}`);
      return err.code === 'bad-settlement' ? EXIT.usage : EXIT.failed;
    }
    if (!err || typeof err.code !== 'string') throw err;
    env.errLine(`Nothing settled: ${err.code}.`);
    return EXIT.failed;
  } finally {
    lock.release();
  }
}

/**
 * Escape a value for a plist string.
 * @param {string} value - Raw value.
 * @returns {string}
 */
function xml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * `install-launchd`: write the launchd job and load it. The job carries
 * paths and a label only.
 * @param {string[]} args - Arguments.
 * @param {object} env - The process seams.
 * @returns {Promise<number>} Exit status.
 */
async function installLaunchd(args, env) {
  const parsed = parseOptions(args, [], ['no-load']);
  if (!parsed || parsed.rest.length) { env.errLine(USAGE); return EXIT.usage; }
  const template = fs.readFileSync(path.join(env.repoDir, 'deploy', `${LABEL}.plist`), 'utf8');
  const job = template.replace(/__NODE_PATH__/g, xml(env.nodePath)).replace(/__REPO_DIR__/g, xml(env.repoDir)).replace(/__HOME__/g, xml(env.home));
  const target = path.join(env.home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.mkdirSync(path.join(env.home, '.tangleclaw', 'logs'), { recursive: true });
  fs.writeFileSync(target, job, { mode: 0o644 });
  env.out(`Wrote ${target}.`);
  if (parsed.options['no-load']) return EXIT.ok;
  // Unload an earlier copy first; that it was not loaded is not a failure.
  await env.launchctl(['bootout', `gui/${env.uid}/${LABEL}`]);
  if (await env.launchctl(['bootstrap', `gui/${env.uid}`, target]) !== 0) {
    env.errLine('launchctl could not load the job.');
    return EXIT.failed;
  }
  env.out('Loaded. The helper starts now and at each login.');
  return EXIT.ok;
}

/**
 * `uninstall-launchd`: unload the job and remove its file. The Keychain
 * items, the config and the record of posts stay.
 * @param {object} env - The process seams.
 * @returns {Promise<number>} Exit status.
 */
async function uninstallLaunchd(env) {
  await env.launchctl(['bootout', `gui/${env.uid}/${LABEL}`]);
  fs.rmSync(path.join(env.home, 'Library', 'LaunchAgents', `${LABEL}.plist`), { force: true });
  env.out('Unloaded and removed the launchd job. The Keychain items, the config and the record of posts are kept.');
  return EXIT.ok;
}

/**
 * Run one command.
 * @param {string[]} argv - Arguments after the program name.
 * @param {object} env - The process seams: `home`, `repoDir`, `nodePath`, `uid`, `pid`, `out`, `errLine`, `stdin`, `launchctl`, `onStop`, and optionally `secrets`, `fetch`, `WebSocket`, `discordApi`, `sleep`, `timers`, `isAlive`.
 * @returns {Promise<number>} Exit status.
 */
async function main(argv, env) {
  const seams = { secrets, ...env };
  const [command, ...args] = argv;
  switch (command) {
    case 'configure': return configure(args, seams);
    case 'set-secret': return setSecret(args, seams);
    case 'preflight': return args.length ? (seams.errLine(USAGE), EXIT.usage) : preflight(seams);
    case 'run': return args.length ? (seams.errLine(USAGE), EXIT.usage) : run(seams);
    case 'status': return args.length ? (seams.errLine(USAGE), EXIT.usage) : status(seams);
    case 'settle': return settle(args, seams);
    case 'install-launchd': return installLaunchd(args, seams);
    case 'uninstall-launchd': return args.length ? (seams.errLine(USAGE), EXIT.usage) : uninstallLaunchd(seams);
    default:
      seams.errLine(USAGE);
      return EXIT.usage;
  }
}

module.exports = { main, LABEL, EXIT, takeLock, isAlive, _internal };
