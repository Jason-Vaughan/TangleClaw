'use strict';

// #2031 (ADR 0023 Decision 11): the parts the bridge's Discord helper is made
// of, each by itself. The log admits only closed codes and id-shaped fields.
// A secret reaches the Keychain on standard input and never in an argument.
// The config refuses to send the helper token anywhere but this machine over
// plain http. The record of posts is owner-only, written whole or not at all,
// and never replaced when it cannot be read. Neither client follows a
// redirect, proven against real servers: the token never arrives where a
// redirect pointed.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { EventEmitter } = require('node:events');

const { createLog, CODES, safeFields } = require('../lib/bridge-helper/log');
const secrets = require('../lib/bridge-helper/secrets');
const config = require('../lib/bridge-helper/config');
const { openState, peekState, nonceFor, StateError, StateWriteError } = require('../lib/bridge-helper/state');
const { createBridgeClient, BridgeError, PATHS, TOKEN_HEADER, NONCE_HEADER } = require('../lib/bridge-helper/bridge-client');
const { createDiscordRest, DiscordError } = require('../lib/bridge-helper/discord-rest');
const { render, split, gatewayReport, PART_MAX } = require('../lib/bridge-helper/outbound');

const HELPER_TOKEN = `bht_${'a'.repeat(43)}`;
const BOT_TOKEN = `${'B'.repeat(24)}.${'c'.repeat(6)}.${'d'.repeat(27)}`;
const IDS = { authorId: '100000000000000001', guildId: '200000000000000002', channelId: '300000000000000003' };

let tmpDir;
let servers;

/**
 * Start a local HTTP server.
 * @param {function(object, object, string): void} handler - Receives the request, the response and the body.
 * @returns {Promise<{origin: string, hits: object[]}>}
 */
async function serve(handler) {
  const hits = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      hits.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler(req, res, body);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { origin: `http://127.0.0.1:${server.address().port}`, hits };
}

/**
 * An origin nothing listens on: a port that was open a moment ago.
 * @returns {Promise<string>}
 */
async function closedOrigin() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  await new Promise((resolve) => server.close(resolve));
  return origin;
}

/**
 * Answer with JSON.
 * @param {object} res - The response.
 * @param {number} status - HTTP status.
 * @param {object} body - JSON body.
 * @param {object} [headers] - Extra headers.
 * @returns {void}
 */
function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

describe('bridge helper: its parts (#2031)', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-bridge-helper-units-'));
    servers = [];
  });

  afterEach(async () => {
    for (const server of servers) await new Promise((resolve) => server.close(resolve));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('the log', () => {
    it('writes a known code with id-shaped fields, and nothing that could carry text or a token', () => {
      const lines = [];
      const log = createLog({ write: (line) => lines.push(line), now: () => new Date('2026-10-04T00:00:00.000Z') });
      log('outbound-posted', {
        outboundId: 12, part: 0, messageId: '300000000000000009', ok: true,
        text: 'the operator said something', token: HELPER_TOKEN, bot: BOT_TOKEN, 'bad key': 'x', nested: { a: 1 }, short: 'bht_abc'
      });
      assert.deepEqual(JSON.parse(lines[0]),
        { at: '2026-10-04T00:00:00.000Z', code: 'outbound-posted', outboundId: 12, part: 0, messageId: '300000000000000009', ok: true });
      assert.deepEqual(safeFields({ leaseId: 'bol_2MryW6AcU_3VpJiWmEqetg' }), { leaseId: 'bol_2MryW6AcU_3VpJiWmEqetg' }, 'a lease id is an id');
    });

    it('writes a code it does not define as unknown-code, never as given', () => {
      const lines = [];
      createLog({ write: (line) => lines.push(line) })('the operator said: deploy it', { outboundId: 1 });
      const record = JSON.parse(lines[0]);
      assert.equal(record.code, 'unknown-code');
      assert.ok(!lines[0].includes('deploy'));
      assert.ok(Object.keys(CODES).every((code) => /^[a-z-]+$/.test(code)));
    });
  });

  describe('the Keychain', () => {
    let realInternal;
    beforeEach(() => { realInternal = { ...secrets._internal }; });
    afterEach(() => { Object.assign(secrets._internal, realInternal); });

    it('stores a secret on standard input, with nothing of it in any argument', async () => {
      const seen = { argv: null, stdin: '' };
      secrets._internal.spawn = (program, argv, options) => {
        const child = new EventEmitter();
        seen.argv = [program, ...argv];
        seen.stdio = options.stdio;
        child.stdin = { end: (text) => { seen.stdin = text; setImmediate(() => child.emit('exit', 0)); } };
        child.kill = () => {};
        return child;
      };
      await secrets.storeSecret('helper', HELPER_TOKEN);
      assert.deepEqual(seen.argv, ['/usr/bin/security', '-i']);
      assert.equal(seen.stdin, `add-generic-password -U -s tangleclaw-bridge-helper -a bridge-helper-token -w ${HELPER_TOKEN}\n`);
      assert.deepEqual(seen.stdio, ['pipe', 'ignore', 'ignore'], 'and security\'s own output goes nowhere');
    });

    it('refuses a value that is not the shape of its token before running anything', async () => {
      let ran = false;
      secrets._internal.spawn = () => { ran = true; };
      for (const [name, value] of [
        ['helper', BOT_TOKEN], ['helper', `${HELPER_TOKEN} -a other`], ['helper', ''], ['bot', 'short'],
        ['bot', `${BOT_TOKEN}"\nadd-generic-password -s x`], ['bot', undefined]
      ]) {
        await assert.rejects(secrets.storeSecret(name, value), (err) => err.code === 'secret-malformed' && !String(err.message).includes(String(value || 'undefined-never')));
      }
      await assert.rejects(secrets.storeSecret('other', HELPER_TOKEN), { code: 'secret-store-failed' });
      assert.equal(ran, false);
    });

    it('reads a secret from security\'s output and answers each failure with a closed code', async () => {
      let answer;
      secrets._internal.execFile = (program, argv, options, done) => {
        // The bot token is read from the Keychain item the install already keeps it in: it is not copied.
        assert.deepEqual([program, ...argv], ['/usr/bin/security', 'find-generic-password', '-s', 'tangleclaw-discord-helper', '-a', 'discord-bot-token', '-w']);
        done(...answer);
      };
      answer = [null, `${BOT_TOKEN}\n`];
      assert.equal(await secrets.readSecret('bot'), BOT_TOKEN);
      answer = [Object.assign(new Error('security: SecKeychainSearchCopyNext: The specified item could not be found'), { code: 44 }), ''];
      await assert.rejects(secrets.readSecret('bot'), (err) => err.code === 'secret-missing' && err.message === 'secret-missing: bot');
      answer = [Object.assign(new Error('User interaction is not allowed.'), { code: 36 }), ''];
      await assert.rejects(secrets.readSecret('bot'), (err) => err.code === 'secret-read-failed' && !err.message.includes('interaction'));
      answer = [null, 'not a token\n'];
      await assert.rejects(secrets.readSecret('bot'), { code: 'secret-malformed' });
      answer = [null, '\n'];
      await assert.rejects(secrets.readSecret('bot'), { code: 'secret-missing' });
    });
  });

  describe('the config', () => {
    it('sends the helper token to this machine only, over http or https', () => {
      for (const ok of ['http://127.0.0.1:3102', 'http://localhost:3102/', 'http://[::1]:3102', 'https://localhost:3102/path', 'https://127.0.0.1:3102']) {
        assert.equal(config.usableOrigin(ok), new URL(ok).origin, ok);
      }
      // The bridge answers the helper only from this machine, so nowhere else is a place to send the token.
      for (const bad of ['http://tc.example.net:3102', 'https://tc.example.net:8443/path', 'http://10.0.0.5:3102', 'https://10.0.0.5', 'ftp://127.0.0.1',
        'https://user:pw@localhost', 'not a url', '', undefined]) {
        assert.equal(config.usableOrigin(bad), null, String(bad));
      }
    });

    it('is written owner-only and whole, and a value that does not pass writes nothing', () => {
      const file = config.paths(tmpDir).config;
      const written = config.writeConfig(file, { baseUrl: 'http://127.0.0.1:3102/x', ...IDS });
      assert.deepEqual(written, { baseUrl: 'http://127.0.0.1:3102', ...IDS, pollSeconds: 15 });
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
      assert.deepEqual(config.readConfig(file), written);

      for (const [field, value] of [
        ['baseUrl', 'http://example.net'], ['authorId', '12'], ['guildId', 'abc'], ['channelId', undefined],
        ['pollSeconds', 4], ['pollSeconds', 301], ['pollSeconds', 15.5]
      ]) {
        assert.throws(() => config.writeConfig(file, { ...written, [field]: value }), (err) => err.code === 'config-invalid' && err.field === field);
      }
      assert.deepEqual(config.readConfig(file), written, 'the earlier config still stands');
    });

    it('tells a missing config from one that does not pass', () => {
      const file = config.paths(tmpDir).config;
      assert.throws(() => config.readConfig(file), { code: 'config-missing' });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, '{not json');
      assert.throws(() => config.readConfig(file), { code: 'config-invalid' });
    });
  });

  describe('the record of posts', () => {
    it('is owner-only, survives a reopen, and keeps its salt', () => {
      const file = path.join(tmpDir, 'helper', 'state.json');
      const first = openState(file);
      first.set(7, { status: 'posting', parts: [], round: 0, since: 1 });
      first.set(8, { status: 'posted', parts: ['300000000000000010'], round: 0 });
      first.remove(8);
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
      const again = openState(file);
      assert.equal(again.salt, first.salt);
      assert.match(again.salt, /^[0-9a-f]{6}$/);
      assert.deepEqual(again.entries(), [[7, { status: 'posting', parts: [], round: 0, since: 1 }]]);
      assert.deepEqual(peekState(file), again.entries());
      assert.deepEqual(fs.readdirSync(path.dirname(file)), ['state.json'], 'no temporary file is left behind');
    });

    it('is never replaced when it cannot be read', () => {
      const file = path.join(tmpDir, 'state.json');
      for (const damaged of ['{half', '{"salt": 1, "items": {}}', '{"salt": "abc"}', 'null']) {
        fs.writeFileSync(file, damaged);
        assert.throws(() => openState(file), StateError);
        assert.throws(() => peekState(file), StateError);
        assert.equal(fs.readFileSync(file, 'utf8'), damaged, 'what was there is still there');
      }
      assert.deepEqual(peekState(path.join(tmpDir, 'absent.json')), [], 'no file yet is not damage');
    });

    it('a write that fails changes nothing, on disk or in the process', () => {
      const dir = path.join(tmpDir, 'locked');
      const file = path.join(dir, 'state.json');
      const state = openState(file);
      state.set(1, { status: 'posted', parts: ['300000000000000011'], round: 0 });
      const before = fs.readFileSync(file, 'utf8');
      fs.chmodSync(dir, 0o500);
      try {
        assert.throws(() => state.set(2, { status: 'posting', parts: [], round: 0 }), StateWriteError);
        assert.throws(() => state.remove(1), StateWriteError);
        assert.equal(state.get(2), undefined, 'the entry that could not be written is not held');
        assert.ok(state.get(1), 'and the one that could not be removed still is');
      } finally {
        fs.chmodSync(dir, 0o700);
      }
      assert.equal(fs.readFileSync(file, 'utf8'), before);
    });

    it('gives each part of each item one nonce of at most 25 characters', () => {
      assert.equal(nonceFor('abc123', 42, 0), 'tcabc123-42-0');
      assert.equal(nonceFor('abc123', 42, 0), nonceFor('abc123', 42, 0));
      const all = [nonceFor('abc123', 42, 0), nonceFor('abc123', 42, 1), nonceFor('abc123', 43, 0), nonceFor('abc124', 42, 0), nonceFor('abc123', 42, 0, 1)];
      assert.equal(new Set(all).size, all.length, 'another part, item, install or round is another nonce');
      assert.ok(nonceFor('abc123', 999999999999, 9, 3).length <= 25);
    });
  });

  describe('the bridge client', () => {
    it('can build the six helper routes and nothing else, and sends the token only in its header', async () => {
      assert.deepEqual(Object.keys(PATHS), ['preflight', 'inbound', 'claim', 'part', 'ack', 'failure']);
      assert.ok(Object.isFrozen(PATHS));
      assert.equal(PATHS.ack('7/../../operator/enable'), '/api/bridge/helper/outbound/NaN/ack', 'an id that is not a number cannot steer the path');

      const tc = await serve((req, res) => json(res, 200, { items: [], replayed: false }));
      const client = createBridgeClient({ origin: tc.origin, token: HELPER_TOKEN });
      assert.deepEqual(Object.keys(client), ['preflight', 'sendInbound', 'claim', 'part', 'ack', 'fail']);
      await client.claim('claim-nonce-0000001', 5);
      await client.ack(7, 'bol_aaaaaaaaaaaaaaaaaaaaaa', ['300000000000000012', '300000000000000014']);
      await client.sendInbound({ externalId: '300000000000000013', text: 'hello' });
      await client.part(7, 'bol_aaaaaaaaaaaaaaaaaaaaaa', { index: 1, count: 2, externalId: '300000000000000014' });
      await client.fail(7, 'bol_aaaaaaaaaaaaaaaaaaaaaa', 'rejected-by-chat', ['300000000000000012'], 2);
      await client.fail(8, 'bol_aaaaaaaaaaaaaaaaaaaaaa', 'transient', [], 1);
      assert.deepEqual(tc.hits.map((h) => `${h.method} ${h.url}`), [
        'POST /api/bridge/helper/outbound/claim', 'POST /api/bridge/helper/outbound/7/ack', 'POST /api/bridge/helper/inbound',
        'POST /api/bridge/helper/outbound/7/parts', 'POST /api/bridge/helper/outbound/7/failure', 'POST /api/bridge/helper/outbound/8/failure'
      ]);
      assert.deepEqual(tc.hits.slice(3).map((h) => JSON.parse(h.body)), [
        { leaseId: 'bol_aaaaaaaaaaaaaaaaaaaaaa', partIndex: 1, partCount: 2, externalId: '300000000000000014' },
        { leaseId: 'bol_aaaaaaaaaaaaaaaaaaaaaa', reason: 'rejected-by-chat', parts: ['300000000000000012'], partCount: 2 },
        { leaseId: 'bol_aaaaaaaaaaaaaaaaaaaaaa', reason: 'transient' }
      ]);
      for (const hit of tc.hits) {
        assert.equal(hit.headers[TOKEN_HEADER], HELPER_TOKEN);
        assert.match(hit.headers[NONCE_HEADER], /^[A-Za-z0-9_-]{16,128}$/);
        assert.ok(!hit.body.includes(HELPER_TOKEN) && !hit.url.includes(HELPER_TOKEN));
      }
      assert.equal(tc.hits[0].headers[NONCE_HEADER], 'claim-nonce-0000001', 'a claim carries the nonce it was given');
      assert.deepEqual(JSON.parse(tc.hits[1].body), {
        leaseId: 'bol_aaaaaaaaaaaaaaaaaaaaaa', parts: ['300000000000000012', '300000000000000014'], partCount: 2
      }, 'an acknowledgement names every part, in order, and how many there are');
      assert.notEqual(tc.hits[1].headers[NONCE_HEADER], tc.hits[2].headers[NONCE_HEADER], 'every other write has a nonce of its own');
    });

    it('a claim carries the Gateway report as one field when it is given one, and nothing of it when it is not (#2272)', async () => {
      const tc = await serve((req, res) => json(res, 200, { items: [], replayed: false }));
      const client = createBridgeClient({ origin: tc.origin, token: HELPER_TOKEN });
      const report = { state: 'reconnecting', since: '2026-10-11T05:03:00.000Z', fatalCloseCode: null };
      await client.claim('claim-nonce-0000005');
      await client.claim('claim-nonce-0000006', 5);
      await client.claim('claim-nonce-0000007', undefined, report);
      await client.claim('claim-nonce-0000008', 5, report);
      assert.deepEqual(tc.hits.map((h) => JSON.parse(h.body)), [{}, { limit: 5 }, { discordGateway: report }, { limit: 5, discordGateway: report }]);
    });

    it('the report is the state, the time to count from, and the close code of a refusal only (#2272)', () => {
      const status = { state: 'ready', since: '2026-10-11T05:00:02.000Z', notReadySince: null, fatalCloseCode: null, resumable: true, reconnectAttempts: 0 };
      assert.deepEqual(gatewayReport(status), { state: 'ready', since: '2026-10-11T05:00:02.000Z', fatalCloseCode: null }, 'ready: since it became ready');
      // Down: counted from when it stopped being ready, not from the attempt in hand.
      assert.deepEqual(gatewayReport({ ...status, state: 'connecting', since: '2026-10-11T05:09:30.000Z', notReadySince: '2026-10-11T05:03:00.000Z', reconnectAttempts: 7 }),
        { state: 'connecting', since: '2026-10-11T05:03:00.000Z', fatalCloseCode: null });
      assert.deepEqual(gatewayReport({ ...status, state: 'fatal', since: '2026-10-11T05:03:00.000Z', notReadySince: '2026-10-11T05:03:00.000Z', fatalCloseCode: 4014 }),
        { state: 'fatal', since: '2026-10-11T05:03:00.000Z', fatalCloseCode: 4014 });
      // Stopped after a refusal: the gateway still remembers the code, and the report is of a stop.
      assert.deepEqual(gatewayReport({ ...status, state: 'stopped', since: '2026-10-11T05:04:00.000Z', notReadySince: '2026-10-11T05:03:00.000Z', fatalCloseCode: 4014 }),
        { state: 'stopped', since: '2026-10-11T05:03:00.000Z', fatalCloseCode: null });
    });

    it('follows no redirect: the token never reaches where one pointed', async () => {
      const elsewhere = await serve((req, res) => json(res, 200, { items: [{ outboundId: 1 }] }));
      for (const status of [301, 302, 307, 308]) {
        const tc = await serve((req, res) => { res.writeHead(status, { location: `${elsewhere.origin}/api/bridge/helper/outbound/claim` }); res.end(); });
        const client = createBridgeClient({ origin: tc.origin, token: HELPER_TOKEN });
        await assert.rejects(client.claim('claim-nonce-0000002'), (err) => err instanceof BridgeError && err.status === status && err.refusalCode === 'REDIRECT_REFUSED');
        assert.equal(tc.hits.length, 1);
      }
      assert.equal(elsewhere.hits.length, 0, 'nothing was sent to the redirect\'s target');
    });

    it('answers a refusal with its status and code, and an unreachable server with status 0, never with the token', async () => {
      const tc = await serve((req, res) => json(res, 409, { error: 'The bridge is disabled.', code: 'BRIDGE_DISABLED' }));
      const client = createBridgeClient({ origin: tc.origin, token: HELPER_TOKEN });
      await assert.rejects(client.claim('claim-nonce-0000003'),
        (err) => err.status === 409 && err.refusalCode === 'BRIDGE_DISABLED' && !err.message.includes(HELPER_TOKEN));
      const gone = createBridgeClient({ origin: await closedOrigin(), token: HELPER_TOKEN });
      await assert.rejects(gone.claim('claim-nonce-0000004'), (err) => err.status === 0 && err.refusalCode === null && !err.message.includes(HELPER_TOKEN));
    });
  });

  describe('the Discord client', () => {
    it('posts with a nonce Discord enforces, pings nobody, and replies without failing on a vanished message', async () => {
      const discord = await serve((req, res) => json(res, 200, { id: '300000000000000020' }));
      const rest = createDiscordRest({ token: BOT_TOKEN, api: discord.origin });
      const made = await rest.createMessage(IDS.channelId, { content: '@everyone hi', nonce: 'tcabc123-1-0', replyTo: '300000000000000019' });
      assert.deepEqual(made, { id: '300000000000000020' });
      const [hit] = discord.hits;
      assert.equal(`${hit.method} ${hit.url}`, `POST /channels/${IDS.channelId}/messages`);
      assert.equal(hit.headers.authorization, `Bot ${BOT_TOKEN}`);
      assert.deepEqual(JSON.parse(hit.body), {
        content: '@everyone hi', nonce: 'tcabc123-1-0', enforce_nonce: true, allowed_mentions: { parse: [] },
        message_reference: { message_id: '300000000000000019', fail_if_not_exists: false }
      });
      await rest.addReaction(IDS.channelId, '300000000000000019', '\u2705');
      assert.equal(discord.hits[1].url, `/channels/${IDS.channelId}/messages/300000000000000019/reactions/%E2%9C%85/@me`);
    });

    it('follows no redirect: the bot token never reaches where one pointed', async () => {
      const elsewhere = await serve((req, res) => json(res, 200, { id: '300000000000000021' }));
      const discord = await serve((req, res) => { res.writeHead(302, { location: `${elsewhere.origin}/channels/1/messages` }); res.end(); });
      const codes = [];
      const rest = createDiscordRest({ token: BOT_TOKEN, api: discord.origin, log: (code) => codes.push(code) });
      await assert.rejects(rest.createMessage(IDS.channelId, { content: 'x', nonce: 'n' }), (err) => err instanceof DiscordError && err.status === 302 && err.sent === 'no');
      assert.equal(elsewhere.hits.length, 0);
      assert.deepEqual(codes, ['redirect-refused']);
    });

    it('says whether Discord may have acted: a refusal did not, a server error or a strange answer may have', async () => {
      let answer;
      const discord = await serve((req, res) => json(res, ...answer));
      const rest = createDiscordRest({ token: BOT_TOKEN, api: discord.origin, sleep: async () => {} });
      const post = () => rest.createMessage(IDS.channelId, { content: 'x', nonce: 'n' });
      answer = [400, { code: 50035, message: 'Invalid Form Body' }];
      await assert.rejects(post(), (err) => err.status === 400 && err.sent === 'no' && err.discordCode === 50035 && !err.message.includes('Invalid'));
      answer = [403, { code: 50013 }];
      await assert.rejects(post(), (err) => err.status === 403 && err.sent === 'no');
      answer = [502, {}];
      await assert.rejects(post(), (err) => err.status === 502 && err.sent === 'unknown');
      answer = [200, { id: 'not-an-id' }];
      await assert.rejects(post(), (err) => err.sent === 'unknown', 'an answer with no usable id may still be a post');
      const unreachable = createDiscordRest({ token: BOT_TOKEN, api: await closedOrigin() });
      await assert.rejects(unreachable.createMessage(IDS.channelId, { content: 'x', nonce: 'n' }), (err) => err.status === 0 && err.sent === 'no',
        'a connection that never opened cannot have posted');
    });

    it('waits out one rate limit as Discord asks, at most thirty seconds, then reports the second', async () => {
      let limited = 1;
      const discord = await serve((req, res) => (limited-- > 0 ? json(res, 429, { retry_after: 0.25 }) : json(res, 200, { id: '300000000000000022' })));
      const waits = [];
      const codes = [];
      const rest = createDiscordRest({ token: BOT_TOKEN, api: discord.origin, sleep: async (ms) => { waits.push(ms); }, log: (code, f) => codes.push([code, f.waitMs]) });
      assert.equal((await rest.createMessage(IDS.channelId, { content: 'x', nonce: 'n' })).id, '300000000000000022');
      assert.deepEqual([waits, codes], [[250], [['discord-rate-limited', 250]]]);

      limited = 5;
      waits.length = 0;
      const stuck = await serve((req, res) => json(res, 429, { retry_after: 900 }));
      const slow = createDiscordRest({ token: BOT_TOKEN, api: stuck.origin, sleep: async (ms) => { waits.push(ms); } });
      await assert.rejects(slow.createMessage(IDS.channelId, { content: 'x', nonce: 'n' }), (err) => err.status === 429 && err.sent === 'no');
      assert.deepEqual([waits, stuck.hits.length], [[30000], 2], 'one wait, capped, and one retry');
    });
  });

  describe('what is posted', () => {
    it('says who an item is from, and a label cannot restyle the line', () => {
      assert.equal(render({ sourceLabel: 'Project Master', text: 'All green.' }), '**Project Master**\nAll green.');
      assert.equal(render({ sourceLabel: 'Project Master, relaying **x** `y` @here', text: 't' }),
        '**Project Master, relaying \\*\\*x\\*\\* \\`y\\` \\@here**\nt');
    });

    it('splits long text into parts Discord takes, at a line break when one is near, losing nothing', () => {
      assert.deepEqual(split('short'), ['short']);
      const lines = Array.from({ length: 400 }, (_, i) => `line ${i} ${'x'.repeat(30)}`).join('\n');
      const parts = split(lines);
      assert.ok(parts.length > 1 && parts.every((p) => Array.from(p).length <= PART_MAX));
      assert.equal(parts.join(''), lines, 'every character is in exactly one part');
      assert.ok(parts.slice(0, -1).every((p) => p.endsWith('\n')), 'each part ends on a line break');

      const unbroken = '\u{1F600}'.repeat(PART_MAX + 10);
      const emoji = split(unbroken);
      assert.deepEqual(emoji.map((p) => Array.from(p).length), [PART_MAX, 10], 'a character is never cut in two');
      assert.equal(emoji.join(''), unbroken);
    });
  });
});
