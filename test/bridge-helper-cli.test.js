'use strict';

// #2031: the bridge helper's commands, with the machine supplied by the test:
// a temporary home, a Keychain that is a map, a `launchctl` that records its
// arguments. Setting up writes an owner-only config and stores each secret
// from standard input. `run` contacts nothing until its config, secrets and
// record are all in order, and only one helper runs. No command prints a
// secret or a Discord id.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Readable } = require('node:stream');

const { main, EXIT, LABEL, takeLock, isAlive, _internal } = require('../lib/bridge-helper/cli');
const { SecretError } = require('../lib/bridge-helper/secrets');
const { paths } = require('../lib/bridge-helper/config');
const { openState } = require('../lib/bridge-helper/state');
const { CODES } = require('../lib/bridge-helper/log');

const HELPER_TOKEN = `bht_${'a'.repeat(43)}`;
const BOT_TOKEN = `${'B'.repeat(24)}.${'c'.repeat(6)}.${'d'.repeat(27)}`;
const IDS = { author: '100000000000000001', guild: '200000000000000002', channel: '300000000000000003' };
const REPO = path.join(__dirname, '..');

let home;
let out;
let err;
let keychain;
let launchctl;

/**
 * The process seams for one command.
 * @param {object} [over] - Overrides.
 * @returns {object}
 */
function env(over = {}) {
  return {
    home, repoDir: REPO, nodePath: '/usr/local/bin/node', uid: 501, pid: process.pid,
    out: (line) => out.push(line), errLine: (line) => err.push(line),
    stdin: Readable.from([]),
    launchctl: async (args) => { launchctl.push(args); return 0; },
    onStop: () => {},
    fetch: () => { throw new Error('the network was used'); },
    WebSocket: function Refused() { throw new Error('a socket was opened'); },
    secrets: {
      storeSecret: async (name, value) => {
        if (!/^(bht_[A-Za-z0-9_-]{43}|[A-Za-z0-9._-]{20,512})$/.test(value)) throw new SecretError('secret-malformed', name);
        keychain.set(name, value);
      },
      readSecret: async (name) => {
        if (!keychain.has(name)) throw new SecretError('secret-missing', name);
        return keychain.get(name);
      }
    },
    ...over
  };
}

/**
 * Write a config that passes.
 * @returns {Promise<void>}
 */
async function configured() {
  const code = await main(['configure', '--base-url', 'http://127.0.0.1:3102', '--author', IDS.author, '--guild', IDS.guild, '--channel', IDS.channel], env());
  assert.equal(code, EXIT.ok);
  out.length = 0;
}

/**
 * Everything a command printed.
 * @returns {string}
 */
function printed() {
  return [...out, ...err].join('\n');
}

describe('bridge helper: its commands (#2031)', () => {
  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-bridge-helper-cli-'));
    out = [];
    err = [];
    keychain = new Map();
    launchctl = [];
  });

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
  });

  it('configure writes an owner-only config and refuses one that does not pass, naming the field and not the value', async () => {
    await configured();
    const file = paths(home).config;
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')),
      { baseUrl: 'http://127.0.0.1:3102', authorId: IDS.author, guildId: IDS.guild, channelId: IDS.channel, pollSeconds: 15, dmChannelId: null, dmEnabled: false });
    const before = fs.readFileSync(file, 'utf8');

    const bad = await main(['configure', '--base-url', 'http://tc.example.net', '--author', IDS.author, '--guild', IDS.guild, '--channel', IDS.channel], env());
    assert.equal(bad, EXIT.usage);
    assert.deepEqual(err, ['Not written: baseUrl is missing or not usable.']);
    // No author at all; then, with one, a poll that is not a number, an unknown option, a missing value and a stray word.
    for (const args of [[], ['--author', IDS.author, '--poll-seconds', 'soon'], ['--author', IDS.author, '--nope', 'x'], ['--author'], ['--author', IDS.author, 'stray']]) {
      assert.equal(await main(['configure', '--base-url', 'http://127.0.0.1:3102', '--guild', IDS.guild, '--channel', IDS.channel, ...args], env()), EXIT.usage, args.join(' '));
    }
    assert.equal(fs.readFileSync(file, 'utf8'), before, 'the config that passed still stands');
  });

  it('set-secret reads the token from standard input, stores it, reads it back, and never prints it', async () => {
    assert.equal(await main(['set-secret', 'helper'], env({ stdin: Readable.from([`${HELPER_TOKEN}\n`]) })), EXIT.ok);
    assert.equal(await main(['set-secret', 'bot'], env({ stdin: Readable.from([BOT_TOKEN.slice(0, 20), `${BOT_TOKEN.slice(20)}\r\n`]) })), EXIT.ok);
    assert.deepEqual([...keychain], [['helper', HELPER_TOKEN], ['bot', BOT_TOKEN]]);
    assert.deepEqual(out, ['Stored the helper token in the Keychain.', 'Stored the bot token in the Keychain.']);

    assert.equal(await main(['set-secret', 'helper'], env({ stdin: Readable.from(['not a token\n']) })), EXIT.failed);
    assert.equal(err.at(-1), 'Nothing stored: that is not the shape of a helper token.');
    const lying = env({ stdin: Readable.from([`${HELPER_TOKEN}\n`]) });
    lying.secrets = { storeSecret: async () => {}, readSecret: async () => `bht_${'z'.repeat(43)}` };
    assert.equal(await main(['set-secret', 'helper'], lying), EXIT.failed, 'a store that does not read back is not a store');
    assert.equal(err.at(-1), 'Nothing stored: secret-store-failed.');
    for (const args of [['set-secret'], ['set-secret', 'other'], ['set-secret', 'bot', HELPER_TOKEN]]) {
      assert.equal(await main(args, env()), EXIT.usage, 'a token is never taken from the command line');
    }
    assert.ok(!printed().includes(HELPER_TOKEN) && !printed().includes(BOT_TOKEN) && !printed().includes('z'.repeat(43)));
  });

  it('reads a token typed at a terminal with echo off', async () => {
    const tty = new Readable({ read() {} });
    const raw = [];
    tty.isTTY = true;
    tty.setRawMode = (on) => { raw.push(on); };
    const done = main(['set-secret', 'helper'], env({ stdin: tty }));
    tty.push(`${HELPER_TOKEN.slice(0, 10)}x\u007f`);
    tty.push(`${HELPER_TOKEN.slice(10)}\r`);
    assert.equal(await done, EXIT.ok);
    assert.equal(keychain.get('helper'), HELPER_TOKEN, 'a backspace removes what it should');
    assert.deepEqual(raw, [true, false], 'raw mode is on while typing and off again after');
    assert.deepEqual(err, ['Paste the helper token and press Return. It is not shown.']);
  });

  it('run contacts nothing until its config, secrets and record are in order, and says which is not', async () => {
    const codeOf = () => JSON.parse(err.at(-1)).code;
    assert.equal(await main(['run'], env()), EXIT.config);
    assert.equal(codeOf(), 'config-missing');
    await configured();
    assert.equal(await main(['run'], env()), EXIT.config);
    assert.equal(codeOf(), 'secret-missing');
    keychain.set('bot', BOT_TOKEN).set('helper', HELPER_TOKEN);

    fs.writeFileSync(paths(home).state, '{half');
    assert.equal(await main(['run'], env()), EXIT.config);
    assert.equal(codeOf(), 'state-unreadable');
    assert.equal(fs.readFileSync(paths(home).state, 'utf8'), '{half', 'and the damaged record is left as it was');
    fs.rmSync(paths(home).state);

    // Another helper holds the lock.
    fs.writeFileSync(paths(home).lock, `${process.pid}\n`);
    assert.equal(await main(['run'], env({ pid: 424242, isAlive: () => true })), EXIT.config);
    assert.deepEqual([codeOf(), JSON.parse(err.at(-1)).pid], ['helper-already-running', process.pid]);
    fs.writeFileSync(paths(home).lock, 'not a pid');
    assert.equal(await main(['run'], env({ pid: 424242 })), EXIT.config);
    assert.equal(JSON.parse(err.at(-1)).pid, -1, 'a lock that cannot be read is not taken over');
    for (const line of err) assert.ok(Object.prototype.hasOwnProperty.call(CODES, JSON.parse(line).code));
    assert.ok(!printed().includes(BOT_TOKEN) && !printed().includes(HELPER_TOKEN));
  });

  it('does not mistake a live process that is not a helper for one', async () => {
    // This test process is alive and is not a helper: a pid reused after an unclean exit looks like this.
    await configured();
    keychain.set('bot', BOT_TOKEN).set('helper', HELPER_TOKEN);
    fs.writeFileSync(paths(home).lock, `${process.pid}\n`);
    assert.equal(await main(['status'], env()), EXIT.ok);
    assert.ok(out.includes('helper: not running'));
    const state = openState(paths(home).state);
    state.set(12, { status: 'uncertain', parts: [], round: 0, since: 1 });
    assert.equal(await main(['settle', '12', '--repost'], env({ pid: 424242 })), EXIT.ok, 'the stale lock is taken over');
  });

  it('when it cannot tell whether a pid is a helper, it says one may be running', () => {
    const real = _internal.execFileSync;
    try {
      assert.equal(isAlive(process.pid), false, 'this test process is alive and is not a helper');
      _internal.execFileSync = () => 'node /repo/bin/tc-bridge-helper run\n';
      assert.equal(isAlive(process.pid), true);
      _internal.execFileSync = () => { throw Object.assign(new Error('no such process'), { status: 1 }); };
      assert.equal(isAlive(process.pid), false, 'ps found no such process');
      _internal.execFileSync = () => { throw Object.assign(new Error('spawnSync /bin/ps ETIMEDOUT'), { code: 'ETIMEDOUT' }); };
      assert.equal(isAlive(process.pid), true, 'ps itself failed: the lock is not taken over on a guess');
      let asked = false;
      _internal.execFileSync = () => { asked = true; return ''; };
      assert.equal(isAlive(2 ** 22 + 12345), false, 'a pid that is gone needs no second opinion');
      assert.equal(asked, false);
    } finally {
      _internal.execFileSync = real;
    }
  });

  it('takes over a lock a dead helper left, and gives its own back', () => {
    const file = paths(home).lock;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '424242\n');
    const lock = takeLock(file, 1234, (pid) => pid !== 424242);
    assert.equal(lock.held, true);
    assert.equal(fs.readFileSync(file, 'utf8'), '1234\n');
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    assert.deepEqual(takeLock(file, 5678, () => true), { held: false, pid: 1234 });
    lock.release();
    assert.equal(fs.existsSync(file), false);
  });

  it('status says how the helper is set up and what it holds, with no secret and no Discord id', async () => {
    assert.equal(await main(['status'], env()), EXIT.ok);
    assert.deepEqual(out, ['config: not set; run configure', 'bot token: missing; run set-secret', 'helper token: missing; run set-secret', 'helper: not running', 'held: nothing']);

    await configured();
    keychain.set('bot', BOT_TOKEN).set('helper', HELPER_TOKEN);
    const state = openState(paths(home).state);
    state.set(12, { status: 'uncertain', parts: ['400000000000000001'], round: 0, since: 1 });
    state.set(15, { status: 'posting', parts: [], round: 0 });
    state.set(16, { status: 'posted', parts: ['400000000000000002'], round: 0 });
    const running = { isAlive: () => true };
    fs.writeFileSync(paths(home).lock, `${process.pid}\n`);
    fs.writeFileSync(paths(home).status, JSON.stringify({ pid: process.pid, at: '2026-10-04T00:00:00.000Z', gateway: { state: 'fatal', fatalCloseCode: 4014 }, lastPassOk: false, held: 2 }));
    out.length = 0;
    assert.equal(await main(['status'], env(running)), EXIT.ok);
    assert.deepEqual(out, [
      'config: set (TangleClaw at http://127.0.0.1:3102, every 15s)',
      'bot token: present', 'helper token: present',
      `helper: running (pid ${process.pid})`,
      'gateway: fatal (close code 4014)',
      'last pass: 2026-10-04T00:00:00.000Z, failed; backing off',
      'in progress: 2 items posting or awaiting acknowledgement',
      'item 12: uncertain, part 2 (settle it: see docs/operator-bridge-helper.md)'
    ]);
    for (const secret of [BOT_TOKEN, HELPER_TOKEN, ...Object.values(IDS), '400000000000000001']) assert.ok(!printed().includes(secret));
  });

  it('settle records what the operator saw, only with the helper stopped, and refuses what is not true of the item', async () => {
    const state = openState(paths(home).state);
    state.set(12, { status: 'uncertain', parts: [], round: 0, since: 1 });
    state.set(15, { status: 'uncertain', parts: ['400000000000000009'], round: 2, since: 1 });
    state.set(16, { status: 'posting', parts: [], round: 0 });

    fs.writeFileSync(paths(home).lock, `${process.pid}\n`);
    assert.equal(await main(['settle', '12', '--repost'], env({ pid: 424242, isAlive: () => true })), EXIT.failed);
    assert.equal(err.at(-1), 'Nothing settled: stop the helper first.');
    fs.rmSync(paths(home).lock);

    assert.equal(await main(['settle', '16', '--repost'], env()), EXIT.failed, 'an item that is merely in progress is not the operator\'s to settle');
    assert.equal(err.at(-1), 'Nothing settled: that item is not held.');
    assert.equal(await main(['settle', '15', '--posted', '400000000000000009'], env()), EXIT.failed);
    assert.equal(err.at(-1), 'Nothing settled: that message id is already recorded for an earlier part.');
    assert.equal(await main(['settle', '12', '--posted', '400000000000000003', '--repost'], env()), EXIT.usage);
    assert.equal(await main(['settle', '99', '--repost'], env()), EXIT.failed);
    assert.equal(err.at(-1), 'Nothing settled: that item is not held.');
    for (const args of [['settle'], ['settle', 'twelve', '--repost'], ['settle', '12', '--discard']]) assert.equal(await main(args, env()), EXIT.usage);

    assert.equal(await main(['settle', '12', '--posted', '400000000000000003'], env()), EXIT.ok);
    assert.deepEqual(out, ['Settled. Item 12 carries on from part 2 once the Project Master has put it back (tc bridge requeue 12).']);
    assert.equal(await main(['settle', '15', '--repost'], env()), EXIT.ok);
    const after = openState(paths(home).state);
    assert.deepEqual(after.get(12), { status: 'posting', parts: ['400000000000000003'], round: 0 });
    assert.deepEqual(after.get(15), { status: 'posting', parts: ['400000000000000009'], round: 3 });
    assert.equal(fs.existsSync(paths(home).lock), false, 'the lock is given back');
  });

  it('install-launchd writes a job with paths and a label only, and loads it', async () => {
    const odd = env({ nodePath: '/opt/node & co/bin/node' });
    assert.equal(await main(['install-launchd'], odd), EXIT.ok);
    const target = path.join(home, 'Library', 'LaunchAgents', `${LABEL}.plist`);
    const job = fs.readFileSync(target, 'utf8');
    assert.ok(job.includes('<string>/opt/node &amp; co/bin/node</string>'));
    assert.ok(job.includes(`<string>${REPO}/bin/tc-bridge-helper</string>`) && job.includes('<string>run</string>'));
    assert.ok(job.includes(`<string>${home}/.tangleclaw/logs/bridge-helper.log</string>`));
    assert.ok(!/__[A-Z_]+__/.test(job), 'no placeholder is left');
    assert.ok(!/EnvironmentVariables|bht_|\d{15,20}/.test(job), 'no environment, no token, no Discord id');
    assert.ok(fs.statSync(path.join(home, '.tangleclaw', 'logs')).isDirectory());
    assert.deepEqual(launchctl, [['bootout', `gui/501/${LABEL}`], ['bootstrap', 'gui/501', target]]);

    launchctl.length = 0;
    assert.equal(await main(['install-launchd', '--no-load'], env()), EXIT.ok);
    assert.deepEqual(launchctl, []);
    const failing = env({ launchctl: async (args) => (args[0] === 'bootstrap' ? 5 : 0) });
    assert.equal(await main(['install-launchd'], failing), EXIT.failed);

    assert.equal(await main(['uninstall-launchd'], env()), EXIT.ok);
    assert.deepEqual(launchctl, [['bootout', `gui/501/${LABEL}`]]);
    assert.equal(fs.existsSync(target), false);
  });

  it('the tracked job template and launcher carry no secret and no Discord id', () => {
    const template = fs.readFileSync(path.join(REPO, 'deploy', `${LABEL}.plist`), 'utf8');
    assert.ok(template.includes(`<string>${LABEL}</string>`));
    assert.deepEqual(template.match(/__[A-Z_]+__/g).filter((v, i, a) => a.indexOf(v) === i).sort(), ['__HOME__', '__NODE_PATH__', '__REPO_DIR__']);
    assert.ok(!/\d{15,20}|bht_/.test(template));
    assert.ok(fs.statSync(path.join(REPO, 'bin', 'tc-bridge-helper')).mode & 0o100, 'the launcher is executable');
  });

  it('answers an unknown command with the usage and nothing else', async () => {
    for (const args of [[], ['help'], ['run', 'now'], ['status', 'x'], ['uninstall-launchd', 'x']]) {
      err.length = 0;
      assert.equal(await main(args, env()), EXIT.usage);
      assert.match(err[0], /^usage: tc-bridge-helper <command>/);
    }
  });
});
