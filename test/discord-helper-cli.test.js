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
// Each passes a check for an `http(s)://` prefix. The first four are not URLs at
// all; the last is one, with credentials the helper would print and never use.
const MALFORMED_URLS = ['http://', 'https://', 'http://exa mple:3102', 'http://:3102', 'https://operator:hunter2@tangleclaw.example'];

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

    it('writes nothing for a base URL that starts like one and is not one', async () => {
      for (const url of MALFORMED_URLS) {
        assert.equal(await cli.main(['configure', '--base-url', url, '--author', IDS.author, '--guild', IDS.guild, '--channel', IDS.channel], deps), 1, url);
        assert.equal(fs.existsSync(p().config), false, url);
      }
      assert.match(outLines.at(-1), /^Not written: --base-url must be an http:\/\/ or https:\/\/ URL with a host/);
      assert.doesNotMatch(outLines.join('\n'), /hunter2/, 'a refused value is not echoed');
    });

    it('accepts every form of address the client can use', async () => {
      for (const url of ['http://127.0.0.1:3102', 'https://tangleclaw.example', 'http://[::1]:3102', 'http://localhost:3102/']) {
        assert.equal(await cli.main(['configure', '--base-url', url, '--author', IDS.author, '--guild', IDS.guild, '--channel', IDS.channel], deps), 0, url);
        assert.equal(cli.loadConfig(p().config).baseUrl, url);
      }
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

    it('answers a malformed base URL as config-invalid in run, verify and status, before anything else happens', async () => {
      withSecrets();
      for (const url of MALFORMED_URLS) {
        // As a config written by hand, or by a helper from before the address was parsed.
        fs.mkdirSync(path.dirname(p().config), { recursive: true });
        fs.writeFileSync(p().config, JSON.stringify({ baseUrl: url, allow: { authorId: IDS.author, guildId: IDS.guild, channelId: IDS.channel }, pollSeconds: 15 }));
        errLines.length = 0;
        outLines.length = 0;
        stopFn = null;
        // Were the address accepted, the helper would start and run until stopped: stop it, and fail on the code.
        const running = cli.main(['run'], deps);
        const early = await Promise.race([running, new Promise((r) => setTimeout(() => r('still running'), 50))]);
        if (stopFn) { stopFn(); await running; }
        assert.equal(early, 78, url);
        assert.deepEqual(errLines.map((l) => JSON.parse(l).code), ['config-invalid'], url);
        assert.equal(await cli.main(['verify'], deps), 78, url);
        assert.equal(outLines.at(-1), 'Cannot verify: config-invalid', url);
        assert.equal(await cli.main(['status'], deps), 0, url);
        assert.ok(outLines.includes('config: config-invalid'), url);
        assert.doesNotMatch(outLines.join('\n'), /hunter2/, 'status does not print an address it refused');
      }
      assert.equal(fs.existsSync(p().dir), false, 'no lock, record or status was written');
      assert.equal(fetchCalls.length, 0, 'Discord and TangleClaw were never contacted');
    });

    it('refuses to start when its lock cannot be written, by closed code', async () => {
      await configure();
      withSecrets();
      fs.mkdirSync(`${p().pid}.4242.tmp`, { recursive: true });
      assert.equal(await cli.main(['run'], deps), 78);
      assert.deepEqual(errLines.map((l) => JSON.parse(l).code), ['lock-failed']);
      assert.equal(fs.existsSync(p().pid), false, 'no lock is left claiming a helper runs');
      fs.rmSync(`${p().pid}.4242.tmp`, { recursive: true });
      assert.deepEqual(fs.readdirSync(p().dir), [], 'and nothing else is left behind');
      assert.equal(fs.existsSync(p().state), false, 'the record is not opened without the lock');
      assert.equal(stopFn, null, 'it never started');
      assert.equal(fetchCalls.length, 0, 'Discord and TangleClaw were never contacted');
    });

    it('leaves no private pid file behind when writing it fails part-way', async () => {
      await configure();
      withSecrets();
      const mine = `${p().pid}.4242.tmp`;
      const realWrite = fs.writeFileSync;
      fs.writeFileSync = (file, ...rest) => {
        if (file !== mine) return realWrite(file, ...rest);
        // A full disk: the file is created, and then the write fails.
        realWrite(file, '');
        throw Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' });
      };
      try {
        assert.equal(await cli.main(['run'], deps), 78);
      } finally {
        fs.writeFileSync = realWrite;
      }
      assert.deepEqual(errLines.map((l) => JSON.parse(l).code), ['lock-failed']);
      assert.deepEqual(fs.readdirSync(p().dir), [], 'the part-written pid file is removed, so restarts do not pile them up');
      assert.equal(stopFn, null, 'it never started');
    });

    it('refuses to start when its record cannot be written, by closed code, and releases the lock', async () => {
      await configure();
      withSecrets();
      const st = openState(p().state);
      st.set(3, { state: 'posting', since: 1, parts: [] });
      const before = fs.readFileSync(p().state, 'utf8');
      fs.mkdirSync(`${p().state}.${process.pid}.tmp`);
      assert.equal(await cli.main(['run'], deps), 78);
      assert.deepEqual(errLines.map((l) => JSON.parse(l).code), ['state-write-failed']);
      assert.equal(fs.readFileSync(p().state, 'utf8'), before, 'the record is as it was');
      assert.equal(fs.existsSync(p().pid), false);
      assert.equal(stopFn, null, 'it never started');
      assert.equal(fetchCalls.length, 0, 'Discord and TangleClaw were never contacted');
    });

    it('refuses to be a second helper, without touching the running one\'s record', async () => {
      await configure();
      withSecrets();
      const st = openState(p().state);
      st.set(3, { state: 'posting', since: 1, parts: [] });
      const before = fs.readFileSync(p().state, 'utf8');
      const mtime = fs.statSync(p().state).mtimeMs;
      fs.writeFileSync(p().pid, '777');
      liveOthers.add(777);
      assert.equal(await cli.main(['run'], deps), 1);
      assert.equal(JSON.parse(errLines.at(-1)).code, 'helper-already-running');
      assert.equal(fs.readFileSync(p().state, 'utf8'), before);
      assert.equal(fs.statSync(p().state).mtimeMs, mtime, 'the record was not rewritten');
    });

    it('releases the lock when it cannot start after taking it', async () => {
      await configure();
      assert.equal(await cli.main(['run'], deps), 78, 'no secrets');
      assert.equal(fs.existsSync(p().pid), false);
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
      st.set(3, { state: 'uncertain', since: 1, parts: [], total: 1 });
      fs.writeFileSync(p().pid, '777');
      liveOthers.add(777);
      assert.equal(await cli.main(['settle', '3', '--posted', '900000000000000009'], deps), 1);
      assert.match(outLines.at(-1), /launchctl bootout gui\/501\/com\.tangleclaw\.discord-helper/);
      liveOthers.clear();
      assert.equal(await cli.main(['settle', '3', '--posted', '900000000000000009'], deps), 0);
      assert.deepEqual(openState(p().state).get(3), { state: 'posted', postedId: '900000000000000009' });
      assert.equal(fs.existsSync(p().pid), false, 'settle took the lock and released it');
      assert.equal(outLines.at(-1), 'Reply 3 is now posted; the helper acknowledges it when it next runs.');
      assert.equal(await cli.main(['settle', '3', '--repost'], deps), 1, 'no longer held');
      assert.equal(outLines.at(-1), 'Reply 3 is not held; nothing to settle.');
      assert.equal(await cli.main(['settle', 'x'], deps), 1);
    });

    it('takes exactly one finding, and prints usage for none or two', async () => {
      const st = openState(p().state);
      st.set(3, { state: 'uncertain', since: 1, parts: [], total: 1 });
      const before = fs.readFileSync(p().state, 'utf8');
      for (const args of [[], ['--posted', '900000000000000009', '--repost'], ['--repost', '--discard'], ['--posted', '900000000000000009', '--discard'], ['--posted'], ['--discard', 'yes']]) {
        outLines.length = 0;
        assert.equal(await cli.main(['settle', '3', ...args], deps), 1, args.join(' '));
        assert.match(outLines[0], /^usage: tc-discord-helper/, args.join(' '));
      }
      assert.match(cli.USAGE, /settle <outbound-id> --posted <discord-message-id> \| --repost \| --discard/);
      assert.equal(fs.readFileSync(p().state, 'utf8'), before, 'nothing was settled');
    });

    it('tells the operator which part was confirmed and what the helper does next', async () => {
      const st = openState(p().state);
      st.set(3, { state: 'uncertain', since: 1, parts: ['800000000000000001'], total: 3 });
      st.set(4, { state: 'uncertain', since: 1, parts: ['800000000000000002'], total: 2 });
      st.set(5, { state: 'uncertain', since: 1, parts: ['800000000000000003'], total: 3 });
      st.set(6, { state: 'uncertain', since: 1, parts: [] });
      st.set(7, { state: 'uncertain', since: 1, parts: [], total: 1 });

      assert.equal(await cli.main(['status'], deps), 0);
      assert.ok(outLines.includes('reply 3: uncertain, part 2 of 3 (settle it: see docs/discord-helper.md)'), outLines.join('\n'));
      assert.ok(outLines.includes('reply 7: uncertain (settle it: see docs/discord-helper.md)'));

      assert.equal(await cli.main(['settle', '3', '--posted', '900000000000000009'], deps), 0);
      assert.equal(outLines.at(-1), 'Reply 3: part 2 of 3 is recorded as posted; the helper posts the parts after it when it next runs.');
      assert.deepEqual(openState(p().state).get(3), { state: 'posting', since: null, parts: ['800000000000000001', '900000000000000009'], total: 3 });

      assert.equal(await cli.main(['settle', '4', '--posted', '900000000000000010'], deps), 0);
      assert.equal(outLines.at(-1), 'Reply 4: part 2 of 2 is recorded as posted, which completes it; the helper acknowledges it when it next runs.');
      assert.deepEqual(openState(p().state).get(4), { state: 'posted', postedId: '800000000000000002' }, 'acknowledged with the first part, not the id typed');

      assert.equal(await cli.main(['settle', '5', '--repost'], deps), 0);
      assert.equal(outLines.at(-1), 'Reply 5 is now posting; the helper posts part 2 of 3 again, then any parts after it, when it next runs.');
      assert.deepEqual(openState(p().state).get(5), { state: 'posting', since: null, parts: ['800000000000000003'], total: 3 });

      assert.equal(await cli.main(['settle', '6', '--posted', '900000000000000011'], deps), 0);
      assert.equal(outLines.at(-1), 'Reply 6: that message is recorded as posted; the helper posts any part after it, then acknowledges the reply, when it next runs.');

      assert.equal(await cli.main(['settle', '7', '--repost'], deps), 0);
      assert.equal(outLines.at(-1), 'Reply 7 is now posting; the helper posts it again when it next runs.');

      // The same confirmation again: nothing is held any more, and nothing is recorded twice.
      assert.equal(await cli.main(['settle', '3', '--posted', '900000000000000009'], deps), 1);
      assert.equal(outLines.at(-1), 'Reply 3 is not held; nothing to settle.');
      assert.deepEqual(openState(p().state).get(3).parts, ['800000000000000001', '900000000000000009']);
    });

    it('discards a rejected reply, and only a rejected one', async () => {
      const st = openState(p().state);
      st.set(3, { state: 'rejected', since: null, parts: [], total: 1 });
      st.set(4, { state: 'rejected', since: null, parts: ['800000000000000001'], total: 3 });
      st.set(5, { state: 'uncertain', since: 1, parts: ['800000000000000002'], total: 2 });
      const before = fs.readFileSync(p().state, 'utf8');

      assert.equal(await cli.main(['status'], deps), 0);
      assert.ok(outLines.includes('reply 3: rejected (settle it: see docs/discord-helper.md)'), outLines.join('\n'));
      assert.ok(outLines.includes('reply 4: rejected, part 2 of 3 (settle it: see docs/discord-helper.md)'));

      // Discord said it did not post: it cannot be confirmed as posted, and posting it again is refused again.
      for (const args of [['--posted', '900000000000000009'], ['--repost']]) {
        assert.equal(await cli.main(['settle', '3', ...args], deps), 1);
        assert.equal(outLines.at(-1), 'Reply 3 is held as rejected: Discord refused it, so it did not post, and posting it again would be refused again. To drop it: settle 3 --discard. Nothing was settled.');
      }
      // It may have posted: discarding it would record that it did not.
      assert.equal(await cli.main(['settle', '5', '--discard'], deps), 1);
      assert.equal(outLines.at(-1), 'Reply 5 is held as uncertain: it may have posted. Look in the channel, then use --posted <discord-message-id> or --repost. Nothing was settled.');
      assert.equal(await cli.main(['settle', '5', '--posted', '800000000000000002'], deps), 1);
      assert.equal(outLines.at(-1), 'That Discord message id is already recorded for an earlier part of reply 5. Nothing was settled.');
      assert.equal(await cli.main(['settle', '5', '--posted', 'abc'], deps), 1);
      assert.equal(outLines.at(-1), 'A Discord message id is digits only. Nothing was settled.');
      // A refusal this command has no words for is not passed off as a bad id.
      const { SettleError } = require('../lib/discord-helper/outbound');
      const realTest = RegExp.prototype.test;
      RegExp.prototype.test = function (v) { if (this.source === '^\\d{1,32}$') throw new SettleError('some-later-refusal'); return realTest.call(this, v); };
      try {
        await assert.rejects(cli.main(['settle', '5', '--posted', '900000000000000009'], deps), (err) => err instanceof SettleError && err.code === 'some-later-refusal');
      } finally {
        RegExp.prototype.test = realTest;
      }
      assert.doesNotMatch(outLines.at(-1), /^Reply 5 is now|recorded as posted/);
      assert.equal(fs.readFileSync(p().state, 'utf8'), before, 'every refusal left the record as it was');

      assert.equal(await cli.main(['settle', '3', '--discard'], deps), 0);
      assert.equal(outLines.at(-1), 'Reply 3 is set to be discarded; when the helper next runs, TangleClaw drops its text and records it as discarded, not as delivered.');
      assert.deepEqual(openState(p().state).get(3), { state: 'discarding', since: null, parts: [], total: 1, reason: 'rejected-by-chat' });
      assert.equal(await cli.main(['settle', '4', '--discard'], deps), 0);
      assert.equal(outLines.at(-1), 'Reply 4 is set to be discarded; when the helper next runs, TangleClaw drops its text and records it as discarded, not as delivered. Its first 1 part(s) did post and stay in the channel.');
      assert.deepEqual(openState(p().state).get(4), { state: 'discarding', since: null, parts: ['800000000000000001'], total: 3, reason: 'rejected-by-chat-partly-posted' });

      assert.equal(await cli.main(['status'], deps), 0);
      assert.ok(outLines.includes('reply 3: discarding (the helper tells TangleClaw when it next runs)'));
      assert.equal(await cli.main(['settle', '3', '--discard'], deps), 1, 'a second discard finds nothing held');
      assert.equal(outLines.at(-1), 'Reply 3 is not held; nothing to settle.');
      assert.equal(fs.existsSync(p().pid), false, 'every settle released the lock');
    });

    it('does not pass off a failure it did not expect as a bad id, and still releases the lock', async () => {
      const st = openState(p().state);
      // A record no helper writes: its parts are not a list.
      st.set(3, { state: 'uncertain', since: 1, parts: 5, total: 2 });
      await assert.rejects(cli.main(['settle', '3', '--posted', '900000000000000009'], deps), TypeError);
      assert.ok(!outLines.some((l) => /digits only|is now|recorded as posted/.test(l)), 'nothing claims a settlement or blames the id');
      assert.equal(fs.existsSync(p().pid), false, 'the lock is released');
      assert.deepEqual(openState(p().state).get(3), { state: 'uncertain', since: 1, parts: 5, total: 2 }, 'the record is as it was');
    });

    it('tells TangleClaw about a discard when the helper next runs, and posts nothing for it', async () => {
      await configure();
      withSecrets();
      const st = openState(p().state);
      st.set(3, { state: 'rejected', since: null, parts: [], total: 1 });
      assert.equal(await cli.main(['settle', '3', '--discard'], deps), 0);
      const running = cli.main(['run'], deps);
      await new Promise((r) => setTimeout(r, 20));
      stopFn();
      assert.equal(await running, 0);
      const call = fetchCalls.find((c) => c.url.endsWith('/discard'));
      assert.deepEqual({ url: call.url, method: call.method, body: JSON.parse(call.body) },
        { url: 'http://127.0.0.1:3102/api/operator-channel/outbound/3/discard', method: 'POST', body: { reason: 'rejected-by-chat' } });
      assert.ok(!fetchCalls.some((c) => c.url.includes('/channels/')), 'nothing was posted to Discord');
      assert.ok(!fetchCalls.some((c) => c.url.endsWith('/ack')), 'and nothing acknowledged as posted');
      assert.ok(errLines.some((l) => JSON.parse(l).code === 'outbound-discarded'));
      assert.deepEqual(openState(p().state).entries(), []);
    });

    it('settles nothing, and says so, when the record or the lock cannot be written', async () => {
      const st = openState(p().state);
      st.set(3, { state: 'uncertain', since: 1, parts: [] });
      const before = fs.readFileSync(p().state, 'utf8');

      // The record opens (it is read), and the settlement's own write is the one that fails.
      const realRename = fs.renameSync;
      let renames = 0;
      fs.renameSync = (from, to) => { if (to === p().state && ++renames === 2) throw Object.assign(new Error('ENOSPC: no space left'), { code: 'ENOSPC' }); return realRename(from, to); };
      try {
        assert.equal(await cli.main(['settle', '3', '--posted', '900000000000000009'], deps), 2);
      } finally {
        fs.renameSync = realRename;
      }
      assert.equal(renames, 2, 'precondition: the second write of the record is the settlement');
      assert.match(outLines.at(-1), /^Cannot write the record \(state-write-failed\).* Nothing was settled\.$/);
      assert.equal(JSON.parse(errLines.at(-1)).code, 'state-write-failed');
      assert.equal(fs.readFileSync(p().state, 'utf8'), before, 'the reply is still held');
      assert.equal(fs.existsSync(p().pid), false, 'the lock is released');

      // The record cannot be written at all.
      fs.mkdirSync(`${p().state}.${process.pid}.tmp`);
      assert.equal(await cli.main(['settle', '3', '--repost'], deps), 2);
      assert.match(outLines.at(-1), /^Cannot write the record \(state-write-failed\)/);
      fs.rmSync(`${p().state}.${process.pid}.tmp`, { recursive: true });
      assert.equal(fs.existsSync(p().pid), false, 'the lock is released');

      // The lock cannot be written.
      fs.mkdirSync(`${p().pid}.4242.tmp`);
      assert.equal(await cli.main(['settle', '3', '--repost'], deps), 2);
      assert.match(outLines.at(-1), /^Cannot take the helper's lock \(lock-failed\).* Nothing was settled\.$/);
      assert.equal(JSON.parse(errLines.at(-1)).code, 'lock-failed');
      fs.rmSync(`${p().pid}.4242.tmp`, { recursive: true });
      assert.equal(fs.readFileSync(p().state, 'utf8'), before, 'nothing was settled');

      assert.equal(await cli.main(['settle', '3', '--repost'], deps), 0, 'and it settles once both can be written');
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
