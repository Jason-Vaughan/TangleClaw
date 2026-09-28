'use strict';

// `tc-discord-helper` (#1799): each command against a temporary home and fakes
// for the Keychain, the network, launchctl and the stop signal. The last test
// sweeps everything the commands wrote and printed for either secret.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { PassThrough } = require('node:stream');

const cli = require('../lib/discord-helper/cli');
const { SecretError } = require('../lib/discord-helper/secrets');
const { openState } = require('../lib/discord-helper/state');

const REPO = path.resolve(__dirname, '..');
const BOT_TOKEN = 'test.bot-token-secret-value.not-a-real-token-0123456789abcdef';
const CHANNEL_TOKEN = `ocsk_${'Q'.repeat(43)}`;
const IDS = { author: '111111111111111111', guild: '222222222222222222', channel: '333333333333333333' };

/**
 * A stdin stream holding `text`.
 * @param {string} text - Input
 * @returns {PassThrough}
 */
function stdinOf(text) {
  const s = new PassThrough();
  s.end(text);
  return s;
}

describe('tc-discord-helper', () => {
  let home;
  let outLines;
  let errLines;
  let keychain;
  let launchctlCalls;
  let liveOthers;
  let stopFn;
  let fetchCalls;
  let deps;

  /**
   * A fetch standing in for TangleClaw and Discord.
   * @param {object} [o] - `{c1Status, discordStatus}`
   * @returns {Function}
   */
  const fakeFetch = (o = {}) => async (url, init) => {
    fetchCalls.push({ url, method: init.method, body: init.body });
    const res = (status, body) => ({ status, json: async () => body });
    if (url.endsWith('/gateway/bot')) return res(200, { url: 'wss://gateway.test' });
    if (url.includes('/api/operator-channel/outbound')) return res(o.c1Status || 200, o.c1Status ? { code: 'CHANNEL_DISABLED' } : { replies: [] });
    if (url.includes('/channels/')) return res(o.discordStatus || 200, o.discordStatus ? { code: 50013 } : { id: '900000000000000001' });
    return res(404, {});
  };

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-dh-cli-'));
    outLines = [];
    errLines = [];
    keychain = new Map();
    launchctlCalls = [];
    liveOthers = new Set();
    stopFn = null;
    fetchCalls = [];
    deps = {
      home, repoDir: REPO, nodePath: '/opt/node/bin/node', uid: 501, pid: 4242,
      out: (l) => outLines.push(l), errLine: (l) => errLines.push(l), stdin: stdinOf(''),
      secrets: {
        readSecret: async (n) => { if (!keychain.has(n)) throw new SecretError('secret-missing', n); return keychain.get(n); },
        storeSecret: async (n, v) => { if (!/^[A-Za-z0-9._-]+$/.test(v)) throw new SecretError('secret-store-failed', n); keychain.set(n, v); }
      },
      fetch: fakeFetch(),
      WebSocket: class { constructor(url) { this.url = url; } addEventListener() {} removeEventListener() {} close() {} },
      launchctl: async (args) => { launchctlCalls.push(args); return 0; },
      alive: (pid) => pid === 4242 || liveOthers.has(pid),
      onStop: (fn) => { stopFn = fn; },
      now: () => Date.parse('2026-09-28T03:00:00Z')
    };
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  const p = () => cli.pathsFor(home);
  const configure = () => cli.main(['configure', '--base-url', 'http://127.0.0.1:3102', '--author', IDS.author, '--guild', IDS.guild, '--channel', IDS.channel], deps);
  const withSecrets = () => { keychain.set('bot', BOT_TOKEN); keychain.set('channel', CHANNEL_TOKEN); };

  describe('configure', () => {
    it('writes the non-secret config owner-only', async () => {
      assert.equal(await configure(), 0);
      const cfg = JSON.parse(fs.readFileSync(p().config, 'utf8'));
      assert.deepEqual(cfg, { baseUrl: 'http://127.0.0.1:3102', allow: { authorId: IDS.author, guildId: IDS.guild, channelId: IDS.channel }, pollSeconds: 15 });
      assert.equal(fs.statSync(p().config).mode & 0o777, 0o600);
    });

    it('writes nothing for an id that is not a Discord id, or a bad URL or interval', async () => {
      for (const args of [
        ['--base-url', 'http://x', '--author', 'me', '--guild', IDS.guild, '--channel', IDS.channel],
        ['--base-url', 'ftp://x', '--author', IDS.author, '--guild', IDS.guild, '--channel', IDS.channel],
        ['--base-url', 'http://x', '--author', IDS.author, '--guild', IDS.guild, '--channel', IDS.channel, '--poll-seconds', '1']
      ]) {
        assert.equal(await cli.main(['configure', ...args], deps), 1);
        assert.equal(fs.existsSync(p().config), false);
      }
      assert.deepEqual(fs.readdirSync(path.join(home, '.tangleclaw')), [], 'no check file is left behind');
    });
  });

  describe('set-secret', () => {
    it('stores what stdin carries, and never echoes it', async () => {
      deps.stdin = stdinOf(`${CHANNEL_TOKEN}\n`);
      assert.equal(await cli.main(['set-secret', 'channel'], deps), 0);
      assert.equal(keychain.get('channel'), CHANNEL_TOKEN);
      assert.doesNotMatch(outLines.join('\n'), /ocsk_/);
    });

    it('reads from a terminal with echo off, honours backspace, and cancels on Ctrl-C', async () => {
      const tty = () => {
        const s = new PassThrough();
        s.isTTY = true;
        s.modes = [];
        s.setRawMode = (on) => { s.modes.push(on); };
        return s;
      };
      let s = tty();
      deps.stdin = s;
      const done = cli.main(['set-secret', 'bot'], deps);
      s.write('abcX\u007f');
      s.write('def\r');
      assert.equal(await done, 0);
      assert.equal(keychain.get('bot'), 'abcdef');
      assert.deepEqual(s.modes, [true, false], 'echo is off while reading and restored after');

      s = tty();
      deps.stdin = s;
      const cancelled = cli.main(['set-secret', 'channel'], deps);
      s.write('abc\u0003');
      assert.equal(await cancelled, 1);
      assert.equal(keychain.has('channel'), false);
      assert.deepEqual(s.modes, [true, false]);
    });

    it('reports a store the Keychain did not keep, by reading it back', async () => {
      deps.secrets.storeSecret = async () => {};
      deps.stdin = stdinOf(BOT_TOKEN);
      assert.equal(await cli.main(['set-secret', 'bot'], deps), 2);
      assert.equal(JSON.parse(errLines.at(-1)).code, 'secret-store-failed');
    });

    it('refuses an unknown secret name, and reports a failed store by code', async () => {
      assert.equal(await cli.main(['set-secret', 'password'], deps), 1);
      deps.stdin = stdinOf('has space');
      assert.equal(await cli.main(['set-secret', 'bot'], deps), 2);
      assert.equal(JSON.parse(errLines.at(-1)).code, 'secret-store-failed');
      assert.doesNotMatch(outLines.join('\n'), /has space/);
    });
  });

  describe('run', () => {
    it('refuses to start without a config, a readable record or its secrets, by closed code', async () => {
      assert.equal(await cli.main(['run'], deps), 78);
      assert.equal(JSON.parse(errLines.at(-1)).code, 'config-missing');
      await configure();
      assert.equal(await cli.main(['run'], deps), 78);
      assert.equal(JSON.parse(errLines.at(-1)).code, 'secret-missing');
      withSecrets();
      fs.mkdirSync(p().dir, { recursive: true });
      fs.writeFileSync(p().state, '{torn');
      assert.equal(await cli.main(['run'], deps), 78);
      assert.equal(JSON.parse(errLines.at(-1)).code, 'state-unreadable');
      assert.equal(fs.readFileSync(p().state, 'utf8'), '{torn', 'the record is left for the operator to inspect');
      assert.equal(fetchCalls.length, 0, 'Discord and TangleClaw were never contacted');
    });

    it('refuses to be a second helper', async () => {
      await configure();
      withSecrets();
      fs.mkdirSync(p().dir, { recursive: true });
      fs.writeFileSync(p().pid, '777');
      liveOthers.add(777);
      assert.equal(await cli.main(['run'], deps), 1);
      assert.equal(JSON.parse(errLines.at(-1)).code, 'helper-already-running');
    });

    it('treats a lock it cannot read as held, never as stale', async () => {
      await configure();
      withSecrets();
      fs.mkdirSync(p().dir, { recursive: true });
      for (const junk of ['', 'not a pid']) {
        fs.writeFileSync(p().pid, junk);
        stopFn = null;
        const running = cli.main(['run'], deps);
        const early = await Promise.race([running, new Promise((r) => setTimeout(() => r('still running'), 50))]);
        if (stopFn) { stopFn(); await running; }
        assert.equal(early, 1, `refused over ${JSON.stringify(junk)}`);
        assert.equal(fs.readFileSync(p().pid, 'utf8'), junk, 'the lock is left alone');
      }
      assert.equal(JSON.parse(errLines.at(-1)).code, 'helper-already-running');
      assert.deepEqual(fs.readdirSync(p().dir).filter((f) => f.endsWith('.tmp')), [], 'no private pid file is left behind');
    });

    it('lets only one of two helpers started at the same instant run', async () => {
      await configure();
      withSecrets();
      const stops = [];
      const twin = (pid) => ({ ...deps, pid, alive: (x) => x === 4242 || x === 4243, onStop: (fn) => stops.push(fn) });
      const results = [];
      const a = cli.main(['run'], twin(4242)).then((c) => results.push(c));
      const b = cli.main(['run'], twin(4243)).then((c) => results.push(c));
      await new Promise((r) => setTimeout(r, 20));
      const started = stops.length;
      const refusedEarly = [...results];
      for (const stop of stops) stop();
      await Promise.all([a, b]);
      assert.equal(started, 1, 'exactly one started');
      assert.deepEqual(refusedEarly, [1], 'the other refused');
      assert.ok(errLines.some((l) => JSON.parse(l).code === 'helper-already-running'));
    });

    it('runs until stopped: asks Discord for the Gateway, polls TangleClaw, keeps a pid and a status, and cleans up', async () => {
      await configure();
      withSecrets();
      fs.mkdirSync(p().dir, { recursive: true });
      fs.writeFileSync(p().pid, '555');
      const running = cli.main(['run'], deps);
      await new Promise((r) => setTimeout(r, 20));
      assert.equal(fs.readFileSync(p().pid, 'utf8'), '4242', 'a stale pid file is taken over');
      assert.ok(fetchCalls.some((c) => c.url.endsWith('/gateway/bot')));
      assert.ok(fetchCalls.some((c) => c.url === 'http://127.0.0.1:3102/api/operator-channel/outbound'));
      const snap = JSON.parse(fs.readFileSync(p().status, 'utf8'));
      assert.equal(snap.pid, 4242);
      assert.equal(typeof stopFn, 'function');
      stopFn();
      assert.equal(await running, 0);
      assert.equal(fs.existsSync(p().pid), false);
      assert.deepEqual(errLines.map((l) => JSON.parse(l).code).filter((c) => c.startsWith('helper-')), ['helper-start', 'helper-stop']);
    });
  });

  describe('status', () => {
    it('shows presence and states, never a value, and never writes the live record', async () => {
      await configure();
      withSecrets();
      const st = openState(p().state);
      st.set(3, { state: 'uncertain', since: 1, parts: [] });
      st.set(4, { state: 'posted', postedId: '9' });
      const before = fs.readFileSync(p().state, 'utf8');
      const mtime = fs.statSync(p().state).mtimeMs;
      assert.equal(await cli.main(['status'], deps), 0);
      const text = outLines.join('\n');
      assert.match(text, /secret bot: present/);
      assert.match(text, /secret channel: present/);
      assert.match(text, /helper: not running/);
      assert.match(text, /reply 3: uncertain \(settle it/);
      assert.doesNotMatch(text, /reply 4/);
      assert.equal(fs.readFileSync(p().state, 'utf8'), before);
      assert.equal(fs.statSync(p().state).mtimeMs, mtime);
    });

    it('survives a status snapshot that parses but is not one', async () => {
      fs.mkdirSync(p().dir, { recursive: true });
      fs.writeFileSync(p().pid, '777');
      liveOthers.add(777);
      fs.writeFileSync(p().status, '{}');
      assert.equal(await cli.main(['status'], deps), 0);
      assert.match(outLines.join('\n'), /status snapshot: unreadable/);
    });

    it('names a missing secret and a missing config by code', async () => {
      assert.equal(await cli.main(['status'], deps), 0);
      const text = outLines.join('\n');
      assert.match(text, /config: config-missing/);
      assert.match(text, /secret bot: secret-missing/);
      assert.match(text, /replies held: none/);
    });
  });

  describe('verify', () => {
    it('proves both tokens and posts one test notification', async () => {
      await configure();
      withSecrets();
      assert.equal(await cli.main(['verify'], deps), 0);
      const post = fetchCalls.find((c) => c.method === 'POST' && c.url.includes('/channels/'));
      assert.equal(post.url, `https://discord.com/api/v10/channels/${IDS.channel}/messages`);
      assert.match(JSON.parse(post.body).content, /TangleClaw: Helper check/);
      assert.ok(!fetchCalls.some((c) => c.url.includes('/ack')), 'verify acknowledges nothing');
    });

    it('fails by status and code, naming no secret', async () => {
      await configure();
      withSecrets();
      deps.fetch = fakeFetch({ c1Status: 503 });
      assert.equal(await cli.main(['verify'], deps), 2);
      assert.match(outLines.at(-1), /503 CHANNEL_DISABLED/);
      deps.fetch = fakeFetch({ discordStatus: 403 });
      assert.equal(await cli.main(['verify'], deps), 2);
      assert.match(outLines.at(-1), /403 code 50013/);
    });
  });

  describe('settle', () => {
    it('refuses while the helper runs, and settles a held reply once it is stopped', async () => {
      const st = openState(p().state);
      st.set(3, { state: 'uncertain', since: 1, parts: [] });
      fs.writeFileSync(p().pid, '777');
      liveOthers.add(777);
      assert.equal(await cli.main(['settle', '3', '--posted', '900000000000000009'], deps), 1);
      assert.match(outLines.at(-1), /launchctl bootout gui\/501\/com\.tangleclaw\.discord-helper/);
      liveOthers.clear();
      assert.equal(await cli.main(['settle', '3', '--posted', '900000000000000009'], deps), 0);
      assert.deepEqual(openState(p().state).get(3), { state: 'posted', postedId: '900000000000000009' });
      assert.equal(await cli.main(['settle', '3', '--repost'], deps), 1, 'no longer held');
      assert.equal(await cli.main(['settle', 'x'], deps), 1);
    });
  });

  describe('launchd', () => {
    it('writes a plist of paths and a label, then reloads it', async () => {
      assert.equal(await cli.main(['install-launchd'], deps), 0);
      const plist = fs.readFileSync(p().plist, 'utf8');
      assert.match(plist, /<string>\/opt\/node\/bin\/node<\/string>/);
      assert.ok(plist.includes(`<string>${REPO}/bin/tc-discord-helper</string>`));
      assert.ok(plist.includes(`${home}/.tangleclaw/logs/discord-helper.log`));
      assert.doesNotMatch(plist, /__[A-Z_]+__/, 'every placeholder is filled');
      const data = plist.replace(/<!--[\s\S]*?-->/g, '');
      assert.doesNotMatch(data, /EnvironmentVariables|ocsk_|token|secret/i, 'the job carries no environment and no secret');
      assert.ok(!plist.includes(BOT_TOKEN) && !plist.includes(CHANNEL_TOKEN));
      assert.ok(fs.existsSync(p().logDir));
      assert.deepEqual(launchctlCalls, [['bootout', 'gui/501/com.tangleclaw.discord-helper'], ['bootstrap', 'gui/501', p().plist]]);
      if (fs.existsSync('/usr/bin/plutil')) execFileSync('/usr/bin/plutil', ['-lint', p().plist]);
    });

    it('can write without loading, and removes what it installed', async () => {
      assert.equal(await cli.main(['install-launchd', '--no-load'], deps), 0);
      assert.deepEqual(launchctlCalls, []);
      assert.equal(await cli.main(['uninstall-launchd'], deps), 0);
      assert.equal(fs.existsSync(p().plist), false);
      assert.deepEqual(launchctlCalls, [['bootout', 'gui/501/com.tangleclaw.discord-helper']]);
    });

    it('reports a failed load', async () => {
      deps.launchctl = async (args) => (args[0] === 'bootstrap' ? 5 : 0);
      assert.equal(await cli.main(['install-launchd'], deps), 2);
    });
  });

  it('prints usage for an unknown command', async () => {
    assert.equal(await cli.main(['frobnicate'], deps), 1);
    assert.match(outLines[0], /^usage: tc-discord-helper/);
  });

  it('leaves neither secret in any file it wrote or anything it printed', async () => {
    await configure();
    deps.stdin = stdinOf(BOT_TOKEN);
    await cli.main(['set-secret', 'bot'], deps);
    deps.stdin = stdinOf(CHANNEL_TOKEN);
    await cli.main(['set-secret', 'channel'], deps);
    await cli.main(['verify'], deps);
    await cli.main(['install-launchd'], deps);
    const running = cli.main(['run'], deps);
    await new Promise((r) => setTimeout(r, 20));
    await cli.main(['status'], deps);
    stopFn();
    await running;
    const written = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else written.push(fs.readFileSync(f, 'utf8')); } };
    walk(home);
    assert.ok(written.length >= 4, 'config, state, status and plist were written');
    const everything = [...written, ...outLines, ...errLines].join('\n');
    assert.ok(!everything.includes(BOT_TOKEN), 'no bot token');
    assert.ok(!everything.includes(CHANNEL_TOKEN), 'no channel token');
    assert.doesNotMatch(everything, /ocsk_/);
  });
});
