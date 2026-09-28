'use strict';

// The Discord helper's modules (#1799), each against fakes for what it talks to:
// the Keychain's `security` binary, TangleClaw's operator channel, Discord's REST
// API and its Gateway. Every #1799 invariant the helper carries on its own side
// has a test here; the ones that need the real channel routes are in
// discord-helper-c1.test.js.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const { createLog, safeFields, CODES } = require('../lib/discord-helper/log');
const secrets = require('../lib/discord-helper/secrets');
const { openState, nonceFor, StateError } = require('../lib/discord-helper/state');
const { createC1Client, PATHS, C1Error } = require('../lib/discord-helper/c1-client');
const { createDiscordRest, DiscordError } = require('../lib/discord-helper/discord-rest');
const gateway = require('../lib/discord-helper/gateway');
const inbound = require('../lib/discord-helper/inbound');
const outbound = require('../lib/discord-helper/outbound');

const BOT_TOKEN = 'test.bot-token-secret-value.not-a-real-token-0123456789abcdef';
const CHANNEL_TOKEN = `ocsk_${'A'.repeat(43)}`;
const ALLOW = Object.freeze({ authorId: '111111111111111111', guildId: '222222222222222222', channelId: '333333333333333333' });
const SELF = '999999999999999999';

/**
 * A log that keeps its lines.
 * @returns {{log: Function, lines: string[], codes: function(): string[]}}
 */
function captureLog() {
  const lines = [];
  const { log } = createLog({ write: (l) => lines.push(l), now: () => new Date('2026-09-28T00:00:00Z') });
  return { log, lines, codes: () => lines.map((l) => JSON.parse(l).code) };
}

/**
 * A fetch that answers from a queue and records every request.
 * @param {Array<object|Function>} answers - `{status, body}`, an Error to throw, or a function of the request
 * @returns {Function & {calls: object[]}}
 */
function fakeFetch(answers) {
  const calls = [];
  const fn = async (url, init) => {
    const req = { url, method: init.method, headers: init.headers, body: init.body ? JSON.parse(init.body) : undefined };
    calls.push(req);
    let a = answers.length > 1 ? answers.shift() : answers[0];
    if (typeof a === 'function') a = a(req);
    if (a instanceof Error) throw a;
    return { status: a.status, json: async () => { if (a.body === undefined) throw new Error('no body'); return a.body; } };
  };
  fn.calls = calls;
  return fn;
}

/**
 * An operator message as the Gateway delivers it.
 * @param {object} [over] - Field overrides
 * @returns {object}
 */
function discordMessage(over = {}) {
  return {
    id: '444444444444444444', type: 0, content: 'hello from the phone',
    author: { id: ALLOW.authorId, bot: false }, guild_id: ALLOW.guildId, channel_id: ALLOW.channelId,
    ...over
  };
}

describe('discord helper log', () => {
  it('writes a closed code and a timestamp, and nothing that can carry text', () => {
    const { log, lines } = captureLog();
    log('inbound-accepted', { messageId: '444444444444444444', text: 'hello there', status: 202, header: `Bearer ${CHANNEL_TOKEN}` });
    const rec = JSON.parse(lines[0]);
    assert.deepEqual(rec, { at: '2026-09-28T00:00:00.000Z', code: 'inbound-accepted', messageId: '444444444444444444', status: 202 });
  });

  it('logs an unknown code as unknown-code rather than printing it', () => {
    const { log, lines } = captureLog();
    log('the secret is hunter2');
    assert.equal(JSON.parse(lines[0]).code, 'unknown-code');
    assert.doesNotMatch(lines[0], /hunter2/);
  });

  it('refuses both secrets even when they are passed as id-shaped fields', () => {
    const out = safeFields({ a: CHANNEL_TOKEN, b: BOT_TOKEN, c: 'ocsk_short', d: '12345678901234567890' });
    assert.deepEqual(out, { d: '12345678901234567890' });
  });

  it('defines every code the modules log', () => {
    const used = new Set();
    for (const f of fs.readdirSync(path.join(__dirname, '../lib/discord-helper'))) {
      const src = fs.readFileSync(path.join(__dirname, '../lib/discord-helper', f), 'utf8');
      for (const m of src.matchAll(/\blog\('([a-z-]+)'/g)) used.add(m[1]);
    }
    assert.ok(used.size > 10, 'precondition: the scan found the log calls');
    for (const code of used) assert.ok(Object.hasOwn(CODES, code), `code ${code} is defined`);
  });
});

describe('discord helper secrets', () => {
  const saved = { ...secrets._internal };
  afterEach(() => Object.assign(secrets._internal, saved));

  it('reads a secret from the Keychain with nothing secret in argv', async () => {
    let seen;
    secrets._internal.execFile = (file, args, opts, cb) => { seen = { file, args }; cb(null, `${BOT_TOKEN}\n`); };
    assert.equal(await secrets.readSecret('bot'), BOT_TOKEN);
    assert.equal(seen.file, '/usr/bin/security');
    assert.deepEqual(seen.args, ['find-generic-password', '-s', 'tangleclaw-discord-helper', '-a', 'discord-bot-token', '-w']);
  });

  it('maps a missing item and any other failure to closed codes, never passing security\'s own output on', async () => {
    secrets._internal.execFile = (f, a, o, cb) => cb(Object.assign(new Error(`security: ${CHANNEL_TOKEN}`), { code: 44 }), '', 'stderr');
    await assert.rejects(secrets.readSecret('channel'), (err) => err.code === 'secret-missing' && !err.message.includes('ocsk_'));
    secrets._internal.execFile = (f, a, o, cb) => cb(Object.assign(new Error('boom'), { code: 51 }), '', `leak ${BOT_TOKEN}`);
    await assert.rejects(secrets.readSecret('bot'), (err) => err.code === 'secret-read-failed' && !err.message.includes('bot-token-secret'));
    secrets._internal.execFile = (f, a, o, cb) => cb(null, '\n');
    await assert.rejects(secrets.readSecret('bot'), { code: 'secret-missing' });
    await assert.rejects(secrets.readSecret('nope'), { code: 'secret-read-failed' });
  });

  /**
   * A fake `security -i` child.
   * @param {number|null} exitCode - What it exits with; null never exits
   * @returns {object} What the spawn saw
   */
  function fakeSpawn(exitCode) {
    const seen = { killed: false, written: [] };
    secrets._internal.spawn = (file, args, opts) => {
      const child = new EventEmitter();
      child.kill = () => { seen.killed = true; };
      child.stdin = { end: (str) => { seen.written.push(str); if (exitCode !== null) setImmediate(() => child.emit('exit', exitCode)); } };
      Object.assign(seen, { file, args, opts });
      return child;
    };
    return seen;
  }

  it('stores a secret by writing one command to security -i on stdin, never in argv', async () => {
    const seen = fakeSpawn(0);
    await secrets.storeSecret('channel', CHANNEL_TOKEN);
    assert.equal(seen.file, '/usr/bin/security');
    assert.deepEqual(seen.args, ['-i'], 'the secret is not in argv');
    assert.equal(seen.opts.env, undefined, 'no environment is built for it');
    assert.deepEqual(seen.opts.stdio, ['pipe', 'ignore', 'ignore']);
    assert.deepEqual(seen.written, [`add-generic-password -U -s tangleclaw-discord-helper -a operator-channel-token -w ${CHANNEL_TOKEN}\n`]);
    await secrets.storeSecret('bot', BOT_TOKEN);
  });

  it('refuses a value that could end the command or start another', async () => {
    const seen = fakeSpawn(0);
    for (const bad of ['a\nfind-generic-password -s x', 'a"b', 'a b', "a'b", 'a;b', '', 'x'.repeat(513)]) {
      await assert.rejects(secrets.storeSecret('bot', bad), { code: 'secret-store-failed' }, JSON.stringify(bad.slice(0, 20)));
    }
    assert.equal(seen.written.length, 0, 'security was never run');
  });

  it('reports a failed store by a closed code, and gives up on a security that hangs', async () => {
    fakeSpawn(44);
    await assert.rejects(secrets.storeSecret('bot', BOT_TOKEN), (err) => err.code === 'secret-store-failed' && !err.message.includes('bot-token-secret'));
    const seen = fakeSpawn(null);
    const realSetTimeout = global.setTimeout;
    global.setTimeout = (fn) => realSetTimeout(fn, 0);
    try {
      await assert.rejects(secrets.storeSecret('bot', BOT_TOKEN), { code: 'secret-store-failed' });
    } finally {
      global.setTimeout = realSetTimeout;
    }
    assert.equal(seen.killed, true);
  });
});

describe('discord helper state', () => {
  let dir;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-dh-state-')); });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('persists entries and its salt across reopening, owner-only', () => {
    const file = path.join(dir, 'sub', 'state.json');
    const a = openState(file);
    a.set(7, { state: 'posted', postedId: '5' });
    const b = openState(file);
    assert.equal(b.salt, a.salt);
    assert.deepEqual(b.get(7), { state: 'posted', postedId: '5' });
    assert.deepEqual(b.entries(), [[7, { state: 'posted', postedId: '5' }]]);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    b.remove(7);
    assert.equal(openState(file).get(7), undefined);
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['state.json'], 'no temp file is left behind');
  });

  it('refuses to start over an unreadable record rather than forgetting what was in flight', () => {
    const file = path.join(dir, 'state.json');
    for (const bad of ['{not json', JSON.stringify({ replies: {} }), 'null']) {
      fs.writeFileSync(file, bad);
      assert.throws(() => openState(file), (err) => err instanceof StateError && err.code === 'state-unreadable');
      assert.equal(fs.readFileSync(file, 'utf8'), bad, 'the file is left as it was');
    }
  });

  it('keeps each nonce within Discord\'s 25 characters and distinct per part', () => {
    const n0 = nonceFor('abcdef', 123456789012);
    const n1 = nonceFor('abcdef', 123456789012, 1);
    assert.ok(n0.length <= 25 && n1.length <= 25);
    assert.notEqual(n0, n1);
    assert.equal(nonceFor('abcdef', 5), 'tcabcdef5');
  });
});

describe('discord helper C1 client', () => {
  it('has exactly three methods and builds only the channel paths', () => {
    const c1 = createC1Client({ baseUrl: 'http://127.0.0.1:3102/some/path', token: CHANNEL_TOKEN, fetch: fakeFetch([{ status: 200, body: {} }]) });
    assert.deepEqual(Object.keys(c1).sort(), ['ack', 'listOutbound', 'sendInbound']);
    assert.ok(Object.isFrozen(PATHS));
    assert.equal(PATHS.ack('../../api/projects'), '/api/operator-channel/outbound/NaN/ack');
  });

  it('sends the token only as a bearer header, to the origin alone', async () => {
    const f = fakeFetch([{ status: 202, body: { inbound: {} } }, { status: 200, body: { replies: [{ id: 1 }] } }, { status: 200, body: {} }]);
    const c1 = createC1Client({ baseUrl: 'http://127.0.0.1:3102/ignored', token: CHANNEL_TOKEN, fetch: f });
    await c1.sendInbound({ id: '1', authorId: '2', spaceId: '3', channelId: '4' }, 'hi');
    assert.deepEqual(await c1.listOutbound(), [{ id: 1 }]);
    await c1.ack(1, '55');
    assert.deepEqual(f.calls.map((c) => `${c.method} ${c.url}`), [
      'POST http://127.0.0.1:3102/api/operator-channel/inbound',
      'GET http://127.0.0.1:3102/api/operator-channel/outbound',
      'POST http://127.0.0.1:3102/api/operator-channel/outbound/1/ack'
    ]);
    for (const c of f.calls) assert.equal(c.headers.Authorization, `Bearer ${CHANNEL_TOKEN}`);
    assert.deepEqual(f.calls[2].body, { postedId: '55' });
  });

  it('types refusals and transport failures without the token in the error', async () => {
    const c1 = createC1Client({ baseUrl: 'http://x', token: CHANNEL_TOKEN, fetch: fakeFetch([{ status: 403, body: { code: 'NOT_ALLOWLISTED', error: CHANNEL_TOKEN } }]) });
    await assert.rejects(c1.sendInbound({}, 'x'), (err) => err instanceof C1Error && err.status === 403 && err.refusalCode === 'NOT_ALLOWLISTED' && !err.message.includes('ocsk_'));
    const down = createC1Client({ baseUrl: 'http://x', token: CHANNEL_TOKEN, fetch: fakeFetch([new Error(`ECONNREFUSED ${CHANNEL_TOKEN}`)]) });
    await assert.rejects(down.listOutbound(), (err) => err.status === 0 && !err.message.includes('ocsk_'));
  });
});

describe('discord helper REST client', () => {
  it('posts with a nonce Discord enforces, no mentions, and a reply reference that tolerates a vanished message', async () => {
    const f = fakeFetch([{ status: 200, body: { id: '777' } }]);
    const rest = createDiscordRest({ token: BOT_TOKEN, fetch: f, api: 'https://d.test' });
    assert.deepEqual(await rest.createMessage('333', { content: 'hi', nonce: 'tcx1', replyTo: '444' }), { id: '777' });
    const c = f.calls[0];
    assert.equal(c.url, 'https://d.test/channels/333/messages');
    assert.equal(c.headers.Authorization, `Bot ${BOT_TOKEN}`);
    assert.deepEqual(c.body, {
      content: 'hi', nonce: 'tcx1', enforce_nonce: true, allowed_mentions: { parse: [] },
      message_reference: { message_id: '444', fail_if_not_exists: false }
    });
  });

  it('honours one 429 with Discord\'s retry_after, then reports rate-limited as not sent', async () => {
    const slept = [];
    const f = fakeFetch([{ status: 429, body: { retry_after: 1.5 } }, { status: 429, body: { retry_after: 1.5 } }]);
    const rest = createDiscordRest({ token: BOT_TOKEN, fetch: f, sleep: async (ms) => slept.push(ms), api: 'https://d.test' });
    await assert.rejects(rest.createMessage('3', { content: 'x', nonce: 'n' }), (err) => err.status === 429 && err.sent === 'no');
    assert.deepEqual(slept, [1500]);
    assert.equal(f.calls.length, 2);
  });

  it('says whether a failed post may have landed', async () => {
    const cases = [
      [{ status: 403, body: { code: 50013 } }, 'no'],
      [{ status: 502, body: {} }, 'unknown'],
      [{ status: 200, body: {} }, 'unknown'],
      [Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }), 'no'],
      [Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND' } }), 'no'],
      [Object.assign(new Error('timeout'), { name: 'TimeoutError' }), 'unknown'],
      [Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNRESET' } }), 'unknown']
    ];
    for (const [answer, sent] of cases) {
      const rest = createDiscordRest({ token: BOT_TOKEN, fetch: fakeFetch([answer]), api: 'https://d.test' });
      await assert.rejects(rest.createMessage('3', { content: 'x', nonce: 'n' }), (err) => err instanceof DiscordError && err.sent === sent, JSON.stringify(answer));
    }
  });

  it('asks Discord where the Gateway is', async () => {
    const f = fakeFetch([{ status: 200, body: { url: 'wss://gateway.discord.gg', shards: 1 } }]);
    assert.equal(await createDiscordRest({ token: BOT_TOKEN, fetch: f, api: 'https://d.test' }).getGatewayUrl(), 'wss://gateway.discord.gg');
    assert.equal(f.calls[0].url, 'https://d.test/gateway/bot');
  });

  it('adds a reaction by its encoded emoji', async () => {
    const f = fakeFetch([{ status: 204 }]);
    await createDiscordRest({ token: BOT_TOKEN, fetch: f, api: 'https://d.test' }).addReaction('3', '4', inbound.ACCEPTED_REACTION);
    assert.equal(f.calls[0].method, 'PUT');
    assert.equal(f.calls[0].url, 'https://d.test/channels/3/messages/4/reactions/%E2%9C%85/@me');
  });
});

describe('discord helper inbound', () => {
  /**
   * @param {object} [c1Answers] - What the fake channel answers, in order
   * @returns {object}
   */
  function rig(c1Answers = [{ status: 202 }]) {
    const handed = [];
    const posted = [];
    const reactions = [];
    const { log, lines, codes } = captureLog();
    const c1 = {
      sendInbound: async (ids, text) => {
        handed.push({ ids, text });
        const a = c1Answers.length > 1 ? c1Answers.shift() : c1Answers[0];
        if (a instanceof Error) throw a;
        return { status: a.status, body: {} };
      }
    };
    const rest = {
      createMessage: async (channelId, m) => { posted.push({ channelId, ...m }); return { id: '1' }; },
      addReaction: async (...args) => { reactions.push(args); }
    };
    const handle = inbound.createInbound({ allow: ALLOW, c1, rest, log, sleep: async () => {}, retryDelayMs: 1 });
    return { handle, handed, posted, reactions, lines, codes };
  }

  /**
   * A message whose content cannot be read without the test knowing.
   * @param {object} over - Field overrides
   * @returns {{msg: object, read: function(): boolean}}
   */
  function tripwired(over) {
    let read = false;
    const msg = discordMessage(over);
    delete msg.content;
    Object.defineProperty(msg, 'content', { enumerable: true, get: () => { read = true; return 'SECRET BODY'; } });
    return { msg, read: () => read };
  }

  const rejected = {
    'another user': { author: { id: '555555555555555555', bot: false } },
    'another guild': { guild_id: '666666666666666666' },
    'another channel': { channel_id: '777777777777777777' },
    'a direct message': { guild_id: undefined },
    'a bot': { author: { id: ALLOW.authorId, bot: true } },
    'a webhook': { webhook_id: '888' },
    'a system message': { type: 7 }
  };
  for (const [what, over] of Object.entries(rejected)) {
    it(`ignores ${what} without reading, logging or relaying its body`, async () => {
      const r = rig();
      const { msg, read } = tripwired(over);
      assert.equal(await r.handle(msg, { selfId: SELF }), 'inbound-ignored');
      assert.equal(read(), false, 'content was never read');
      assert.equal(r.handed.length, 0);
      assert.equal(r.posted.length + r.reactions.length, 0, 'nothing is said back to anyone else');
      assert.doesNotMatch(r.lines.join('\n'), /SECRET BODY/);
    });
  }

  it('ignores the bot\'s own messages even when it is the allowlisted author', async () => {
    const r = rig();
    const { msg, read } = tripwired({ author: { id: SELF, bot: false } });
    const handle = inbound.createInbound({ allow: { ...ALLOW, authorId: SELF }, c1: { sendInbound: async () => assert.fail('relayed') }, rest: {}, log: () => {} });
    assert.equal(await handle(msg, { selfId: SELF }), 'inbound-ignored');
    assert.equal(read(), false);
    assert.equal(r.handed.length, 0);
  });

  it('hands the operator\'s message over under its Discord id, text untouched, and reacts', async () => {
    const r = rig([{ status: 202 }]);
    assert.equal(await r.handle(discordMessage(), { selfId: SELF }), 'inbound-accepted');
    assert.deepEqual(r.handed, [{
      ids: { id: '444444444444444444', authorId: ALLOW.authorId, spaceId: ALLOW.guildId, channelId: ALLOW.channelId },
      text: 'hello from the phone'
    }]);
    assert.deepEqual(r.reactions, [[ALLOW.channelId, '444444444444444444', '✅']]);
    assert.doesNotMatch(r.lines.join('\n'), /hello from the phone/, 'the body is never logged');
  });

  it('relays a merge or release request as plain text and does nothing else with it', async () => {
    const r = rig([{ status: 202 }]);
    const text = 'Approved: merge PR #2001 and cut the v5.31 release now.';
    assert.equal(await r.handle(discordMessage({ content: text }), { selfId: SELF }), 'inbound-accepted');
    assert.equal(r.handed.length, 1);
    assert.equal(r.handed[0].text, text);
    assert.equal(r.posted.length, 0, 'no reply claims anything was approved');
  });

  it('treats a replay TangleClaw already has as settled', async () => {
    const r = rig([{ status: 200 }]);
    assert.equal(await r.handle(discordMessage(), { selfId: SELF }), 'inbound-replayed');
    assert.equal(r.reactions.length, 1);
  });

  const refusals = [
    [403, 'NOT_ALLOWLISTED'], [503, 'CHANNEL_DISABLED'], [409, 'NO_TARGET'], [400, 'UNSAFE_TEXT'],
    [413, null], [429, 'RATE_LIMITED'], [401, null], [400, 'BAD_MESSAGE']
  ];
  for (const [status, code] of refusals) {
    it(`tells the operator, in fixed words, when TangleClaw answers ${status} ${code || ''}`, async () => {
      const r = rig([new C1Error(status, code)]);
      assert.equal(await r.handle(discordMessage({ content: 'my private words' }), { selfId: SELF }), 'inbound-refused');
      assert.equal(r.handed.length, 1, 'a refusal is not retried');
      assert.equal(r.posted.length, 1);
      const notice = r.posted[0];
      assert.ok(Object.values(inbound.REFUSAL_TEXT).includes(notice.content));
      assert.equal(notice.replyTo, '444444444444444444');
      assert.equal(notice.nonce, 'r444444444444444444', 'a replayed refusal cannot be answered twice');
      assert.equal(r.reactions.length, 0);
      assert.deepEqual(r.codes(), ['inbound-refused']);
    });
  }

  it('retries an unreachable TangleClaw a bounded number of times, then says it was not delivered', async () => {
    const r = rig([new C1Error(0, null)]);
    assert.equal(await r.handle(discordMessage(), { selfId: SELF }), 'inbound-transport-failed');
    assert.equal(r.handed.length, inbound.TRANSPORT_ATTEMPTS);
    assert.equal(r.posted[0].content, inbound.REFUSAL_TEXT.UNREACHABLE);
  });

  it('delivers on a retry after a passing transport failure', async () => {
    const r = rig([new C1Error(0, null), { status: 202 }]);
    assert.equal(await r.handle(discordMessage(), { selfId: SELF }), 'inbound-accepted');
    assert.equal(r.handed.length, 2);
    assert.equal(r.posted.length, 0);
  });
});

describe('discord helper outbound', () => {
  let dir;
  let state;
  let clock;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-dh-out-'));
    state = openState(path.join(dir, 'state.json'));
    clock = Date.parse('2026-09-28T00:00:00Z');
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  /**
   * A fake operator channel holding outbound items until they are acked.
   * @param {object[]} items - Waiting items
   * @returns {object}
   */
  function fakeC1(items) {
    const acks = [];
    return {
      items, acks, down: false, ackDown: false,
      async listOutbound() { if (this.down) throw new C1Error(0, null); return this.items.map((i) => ({ ...i })); },
      async ack(id, postedId) {
        if (this.ackDown) throw new C1Error(0, null);
        const i = this.items.findIndex((x) => x.id === id);
        if (i < 0) throw new C1Error(404, 'NOT_FOUND');
        acks.push({ id, postedId });
        this.items.splice(i, 1);
        return { status: 200, body: {} };
      }
    };
  }

  /**
   * A fake Discord that de-duplicates by nonce, as `enforce_nonce` does.
   * @returns {object}
   */
  function fakeDiscord() {
    const messages = [];
    const byNonce = new Map();
    let next = 1000;
    return {
      messages, fail: null, attempts: 0,
      async createMessage(channelId, m) {
        this.attempts += 1;
        if (this.fail) { const f = this.fail; if (f.once) this.fail = null; if (f.landFirst) { this.land(channelId, m); } throw new DiscordError(f.status, null, f.sent); }
        return this.land(channelId, m);
      },
      land(channelId, m) {
        if (byNonce.has(m.nonce)) return { id: byNonce.get(m.nonce) };
        const id = String(next++);
        byNonce.set(m.nonce, id);
        messages.push({ id, channelId, ...m });
        return { id };
      }
    };
  }

  const item = (id, text = `reply ${id}`, extra = {}) => ({ id, kind: 'reply', type: null, text, inReplyTo: null, ...extra });

  /**
   * @param {object} c1 - Fake channel
   * @param {object} rest - Fake Discord
   * @returns {object}
   */
  function relay(c1, rest, logSink = captureLog()) {
    return { out: outbound.createOutbound({ c1, rest, state, channelId: ALLOW.channelId, log: logSink.log, now: () => clock }), logs: logSink };
  }

  it('posts each item, in order, and acknowledges it with the id Discord returned', async () => {
    const c1 = fakeC1([item(1, 'first', { inReplyTo: { messageId: '444' } }), item(2, 'second')]);
    const d = fakeDiscord();
    const { out } = relay(c1, d);
    assert.equal(await out.tick(), 'ok');
    assert.deepEqual(d.messages.map((m) => [m.content, m.replyTo]), [['first', '444'], ['second', undefined]]);
    assert.deepEqual(c1.acks, [{ id: 1, postedId: d.messages[0].id }, { id: 2, postedId: d.messages[1].id }]);
    assert.deepEqual(state.entries(), [], 'nothing is left in the local record');
  });

  it('never acknowledges during a Discord outage, and delivers everything once it recovers', async () => {
    const c1 = fakeC1([item(1), item(2)]);
    const d = fakeDiscord();
    d.fail = { status: 0, sent: 'no' };
    const { out } = relay(c1, d);
    for (let i = 0; i < 3; i++) { assert.equal(await out.tick(), 'failed'); clock += 60 * 60 * 1000; }
    assert.equal(c1.acks.length, 0);
    assert.equal(c1.items.length, 2, 'the items stay waiting on TangleClaw');
    assert.equal(d.attempts, 3, 'one attempt per poll, not a burst');
    d.fail = null;
    assert.equal(await out.tick(), 'ok');
    assert.equal(d.messages.length, 2);
    assert.deepEqual(c1.acks.map((a) => a.id), [1, 2]);
  });

  it('after a restart between post and ack, only re-acknowledges the exact item', async () => {
    const c1 = fakeC1([item(1), item(2)]);
    const d = fakeDiscord();
    c1.ackDown = true;
    await relay(c1, d).out.tick();
    assert.equal(d.messages.length, 1);
    assert.equal(state.get(1).state, 'posted');
    // Restart: a new relay over the same state file.
    state = openState(path.join(dir, 'state.json'));
    c1.ackDown = false;
    const { out } = relay(c1, d);
    assert.equal(await out.tick(), 'ok');
    assert.equal(d.attempts, 2, 'item 1 is never posted again; item 2 is posted once');
    assert.deepEqual(c1.acks, [{ id: 1, postedId: d.messages[0].id }, { id: 2, postedId: d.messages[1].id }]);
  });

  it('after a crash mid-post, retries with the same nonce inside the window, so Discord returns the same message', async () => {
    const c1 = fakeC1([item(1)]);
    const d = fakeDiscord();
    d.fail = { status: 0, sent: 'unknown', landFirst: true, once: true };
    await relay(c1, d).out.tick();
    assert.equal(state.get(1).state, 'posting');
    assert.equal(d.messages.length, 1, 'the post did land');
    state = openState(path.join(dir, 'state.json'));
    clock += 30 * 1000;
    assert.equal(await relay(c1, d).out.tick(), 'ok');
    assert.equal(d.messages.length, 1, 'no duplicate');
    assert.deepEqual(c1.acks, [{ id: 1, postedId: d.messages[0].id }]);
  });

  it('past the nonce window marks the item uncertain, never acks or reposts it, and keeps relaying the rest', async () => {
    const c1 = fakeC1([item(1), item(2)]);
    const d = fakeDiscord();
    d.fail = { status: 502, sent: 'unknown', once: true };
    await relay(c1, d).out.tick();
    clock += outbound.NONCE_WINDOW_MS + 1;
    const { out, logs } = relay(c1, d);
    for (let i = 0; i < 5; i++) { await out.tick(); clock += 60 * 1000; }
    assert.equal(state.get(1).state, 'uncertain');
    assert.equal(d.attempts, 2, 'item 1 was tried once and never again; item 2 once');
    assert.deepEqual(c1.acks.map((a) => a.id), [2]);
    assert.equal(logs.codes().filter((c) => c === 'outbound-uncertain').length, 1);
    assert.deepEqual(out.status().items, [{ outboundId: 1, state: 'uncertain', partsPosted: 0 }]);
  });

  it('settles an uncertain item the way the operator says', async () => {
    const c1 = fakeC1([item(1), item(2)]);
    const d = fakeDiscord();
    state.set(1, { state: 'uncertain', since: clock, parts: [] });
    state.set(2, { state: 'uncertain', since: clock, parts: [] });
    const { out } = relay(c1, d);
    assert.throws(() => out.settleUncertain(3, { repost: true }), /not-held/);
    assert.throws(() => out.settleUncertain(1, { postedId: 'not an id' }), /bad-settlement/);
    out.settleUncertain(1, { postedId: '123456' });
    out.settleUncertain(2, { repost: true });
    await out.tick();
    assert.deepEqual(c1.acks, [{ id: 1, postedId: '123456' }, { id: 2, postedId: d.messages[0].id }]);
    assert.equal(d.messages.length, 1);
  });

  it('sets aside an item Discord rejects itself, and keeps relaying the rest', async () => {
    const c1 = fakeC1([item(1), item(2)]);
    const d = fakeDiscord();
    d.fail = { status: 400, sent: 'no', once: true };
    const { out, logs } = relay(c1, d);
    assert.equal(await out.tick(), 'ok');
    assert.equal(await out.tick(), 'ok');
    assert.equal(state.get(1).state, 'rejected');
    assert.equal(d.attempts, 2, 'item 1 was tried once and never again');
    assert.deepEqual(c1.acks.map((a) => a.id), [2]);
    assert.ok(logs.codes().includes('outbound-rejected'));
    out.settleUncertain(1, { repost: true });
    await out.tick();
    assert.deepEqual(c1.acks.map((a) => a.id), [2, 1]);
  });

  for (const status of [401, 403, 404, 429]) {
    it(`stops the poll on a ${status}, which concerns the whole channel, without setting the item aside`, async () => {
      const c1 = fakeC1([item(1), item(2)]);
      const d = fakeDiscord();
      d.fail = { status, sent: 'no' };
      const { out } = relay(c1, d);
      assert.equal(await out.tick(), 'failed');
      assert.equal(d.attempts, 1);
      assert.notEqual(state.get(1) && state.get(1).state, 'rejected');
    });
  }

  it('forgets entries for items a complete listing no longer holds, and only then', async () => {
    const c1 = fakeC1([]);
    state.set(5, { state: 'posting', since: clock, parts: [] });
    state.set(6, { state: 'uncertain', since: clock, parts: [] });
    const full = Array.from({ length: outbound.LIST_PAGE }, (_, k) => item(100 + k));
    c1.items = full;
    c1.ackDown = true;
    const d = fakeDiscord();
    d.fail = { status: 0, sent: 'no' };
    await relay(c1, d).out.tick();
    assert.ok(state.get(5) && state.get(6), 'a full page may be hiding them');
    c1.items = [];
    await relay(c1, d).out.tick();
    assert.equal(state.get(5), undefined);
    assert.equal(state.get(6), undefined);
  });

  it('drops a posted item TangleClaw no longer has instead of retrying its ack forever', async () => {
    const c1 = fakeC1([]);
    state.set(9, { state: 'posted', postedId: '1' });
    await relay(c1, fakeDiscord()).out.tick();
    assert.equal(state.get(9), undefined);
  });

  it('acknowledges a posted item even when it is beyond the listing\'s page', async () => {
    const c1 = fakeC1([item(1)]);
    const list = c1.listOutbound;
    c1.listOutbound = async function () { return (await list.call(this)).filter((i) => i.id !== 1); };
    state.set(1, { state: 'posted', postedId: '42' });
    await relay(c1, fakeDiscord()).out.tick();
    assert.deepEqual(c1.acks, [{ id: 1, postedId: '42' }]);
  });

  it('renders a notification under its title and a reply as written', () => {
    assert.equal(outbound.render(item(1, 'plain words')), 'plain words');
    assert.equal(outbound.render({ id: 2, kind: 'notification', type: 'operator-needed', text: 'An exchange needs you.' }),
      '\u{1F514} **TangleClaw: Operator needed**\nAn exchange needs you.');
    assert.match(outbound.render({ id: 3, kind: 'notification', type: 'something-new', text: 'x' }), /TangleClaw: Notification\*\*/);
  });

  it('splits a long item into Discord-sized parts, posts them in order, and acks with the first', async () => {
    const long = `${'a'.repeat(1500)}\n${'b'.repeat(1500)}\n${'c'.repeat(100)}`;
    const c1 = fakeC1([item(1, long, { inReplyTo: { messageId: '444' } })]);
    const d = fakeDiscord();
    await relay(c1, d).out.tick();
    assert.equal(d.messages.length, 2);
    assert.equal(d.messages.map((m) => m.content).join(''), long);
    assert.equal(d.messages[0].replyTo, '444');
    assert.equal(d.messages[1].replyTo, undefined);
    assert.notEqual(d.messages[0].nonce, d.messages[1].nonce);
    assert.deepEqual(c1.acks, [{ id: 1, postedId: d.messages[0].id }]);
  });

  it('resumes a split item at the part that did not post', async () => {
    const long = 'x'.repeat(outbound.DISCORD_MAX * 2 + 10);
    const c1 = fakeC1([item(1, long)]);
    const d = fakeDiscord();
    let n = 0;
    const real = d.createMessage.bind(d);
    d.createMessage = async (ch, m) => { n += 1; if (n === 2) throw new DiscordError(0, null, 'no'); return real(ch, m); };
    await relay(c1, d).out.tick();
    assert.equal(state.get(1).parts.length, 1);
    await relay(c1, d).out.tick();
    assert.equal(d.messages.length, 3, 'each part posted exactly once');
    assert.equal(c1.acks.length, 1);
  });

  it('caps a very long item and says how much was cut, never splitting a character', () => {
    const parts = outbound.split('\u{1F600}'.repeat(outbound.DISCORD_MAX * (outbound.MAX_PARTS + 1)));
    assert.equal(parts.length, outbound.MAX_PARTS);
    for (const p of parts) {
      assert.ok(Array.from(p).length <= outbound.DISCORD_MAX);
      assert.doesNotMatch(p, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/, 'no lone surrogate');
    }
    assert.match(parts.at(-1), /\[\.\.\. \d+ more characters not shown\]$/);
  });

  it('counts exactly how many characters the cut left out', () => {
    for (const total of [outbound.DISCORD_MAX * outbound.MAX_PARTS + 1, outbound.DISCORD_MAX * outbound.MAX_PARTS + 99999]) {
      const parts = outbound.split('y'.repeat(total));
      const shown = parts.reduce((n, p) => n + (p.match(/y/g) || []).length, 0);
      const said = Number(parts.at(-1).match(/\[\.\.\. (\d+) more/)[1]);
      assert.equal(shown + said, total);
      assert.ok(Array.from(parts.at(-1)).length <= outbound.DISCORD_MAX);
    }
  });

  it('backs off exponentially on failure, capped, and returns to the interval on success', async () => {
    const c1 = fakeC1([]);
    c1.down = true;
    const timers = { pending: [], setTimeout(fn, ms) { this.pending.push({ fn, ms }); return this.pending.length; }, clearTimeout() {} };
    const out = outbound.createOutbound({ c1, rest: fakeDiscord(), state, channelId: ALLOW.channelId, log: () => {}, timers, intervalMs: 15000, maxBackoffMs: 60000 });
    out.start();
    const delays = [];
    for (let i = 0; i < 6; i++) {
      const t = timers.pending.shift();
      delays.push(t.ms);
      await t.fn();
      if (i === 4) c1.down = false;
    }
    assert.deepEqual(delays, [0, 30000, 60000, 60000, 60000, 60000], "the first failure doubles the interval; the cap holds");
    assert.equal(timers.pending.shift().ms, 15000);
    out.stop();
  });

  it('never runs two polls at once', async () => {
    const c1 = fakeC1([item(1)]);
    const d = fakeDiscord();
    const { out } = relay(c1, d);
    await Promise.all([out.tick(), out.tick(), out.tick()]);
    assert.equal(d.messages.length, 1);
  });

  it('shows ids and states in status, never text', async () => {
    const c1 = fakeC1([item(1, 'confidential reply')]);
    c1.ackDown = true;
    const { out } = relay(c1, fakeDiscord());
    await out.tick();
    const s = JSON.stringify(out.status());
    assert.doesNotMatch(s, /confidential/);
    assert.deepEqual(out.status().items, [{ outboundId: 1, state: 'posted', partsPosted: 1 }]);
  });
});

describe('discord helper gateway', () => {
  /** A fake WebSocket the test drives. */
  class FakeWS {
    /** @param {string} url - URL */
    constructor(url) {
      FakeWS.all.push(this);
      this.url = url;
      this.readyState = 1;
      this.sent = [];
      this.closedWith = null;
      this.h = {};
    }

    /** @param {string} t - Type @param {Function} f - Handler @returns {void} */
    addEventListener(t, f) { (this.h[t] ||= []).push(f); }

    /** @param {string} t - Type @param {Function} f - Handler @returns {void} */
    removeEventListener(t, f) { this.h[t] = (this.h[t] || []).filter((x) => x !== f); }

    /** @param {string} d - Frame @returns {void} */
    send(d) { this.sent.push(JSON.parse(d)); }

    /** @param {number} code - Close code @returns {void} */
    close(code) { this.closedWith = code; this.readyState = 3; }

    /** @param {object} p - Payload @returns {void} */
    recv(p) { for (const f of this.h.message || []) f({ data: JSON.stringify(p) }); }

    /** @param {number} code - Close code @returns {void} */
    serverClose(code) { this.readyState = 3; for (const f of this.h.close || []) f({ code }); }
  }

  /** Timers the test fires by hand. */
  function manualTimers() {
    let n = 0;
    const t = {
      list: new Map(),
      setTimeout(fn, ms) { n += 1; t.list.set(n, { fn, ms, kind: 'timeout' }); return n; },
      setInterval(fn, ms) { n += 1; t.list.set(n, { fn, ms, kind: 'interval' }); return n; },
      clearTimeout(id) { t.list.delete(id); },
      clearInterval(id) { t.list.delete(id); },
      /** Fire the only pending timer of a kind. */
      fire(kind = 'timeout') {
        const entry = [...t.list.entries()].find(([, v]) => v.kind === kind);
        assert.ok(entry, `a ${kind} is pending`);
        if (kind === 'timeout') t.list.delete(entry[0]);
        entry[1].fn();
        return entry[1].ms;
      }
    };
    return t;
  }

  let timers;
  let received;
  let logs;
  let gw;
  beforeEach(() => {
    FakeWS.all = [];
    timers = manualTimers();
    received = [];
    logs = captureLog();
    gw = gateway.createGateway({
      token: BOT_TOKEN, WebSocket: FakeWS, timers, random: () => 0.5, log: logs.log,
      onMessageCreate: (d, ctx) => received.push({ d, ctx }), backoffBaseMs: 1000, backoffMaxMs: 8000
    });
  });
  afterEach(() => gw.stop());

  const ws = () => FakeWS.all.at(-1);

  /** Connect and reach READY. */
  function ready() {
    gw.start();
    ws().recv({ op: 10, d: { heartbeat_interval: 40000 } });
    ws().recv({ op: 0, t: 'READY', s: 1, d: { session_id: 'sess1', resume_gateway_url: 'wss://resume.test', user: { id: SELF } } });
  }

  it('identifies with only GUILDS, GUILD_MESSAGES and MESSAGE_CONTENT', () => {
    gw.start();
    assert.equal(ws().url, 'wss://gateway.discord.gg/?v=10&encoding=json');
    ws().recv({ op: 10, d: { heartbeat_interval: 40000 } });
    const id = ws().sent.find((p) => p.op === 2);
    assert.equal(id.d.intents, 1 + 512 + 32768);
    assert.equal(id.d.token, BOT_TOKEN);
  });

  it('heartbeats with the last sequence, first after a jittered wait', () => {
    ready();
    assert.equal(timers.fire(), 20000, 'interval × jitter');
    assert.deepEqual(ws().sent.at(-1), { op: 1, d: 1 });
    ws().recv({ op: 11 });
    ws().recv({ op: 0, t: 'TYPING_START', s: 5, d: {} });
    timers.fire('interval');
    assert.deepEqual(ws().sent.at(-1), { op: 1, d: 5 });
  });

  it('answers a heartbeat request at once', () => {
    ready();
    ws().recv({ op: 1 });
    assert.deepEqual(ws().sent.at(-1), { op: 1, d: 1 });
  });

  it('treats a missing heartbeat ACK as a zombie: closes resumably and resumes on the resume URL', () => {
    ready();
    timers.fire();
    const first = ws();
    timers.fire('interval');
    assert.equal(first.closedWith, gateway.RESUME_CLOSE);
    assert.notEqual(first.closedWith, 1000);
    timers.fire();
    assert.equal(ws().url, 'wss://resume.test/?v=10&encoding=json');
    ws().recv({ op: 10, d: { heartbeat_interval: 40000 } });
    assert.deepEqual(ws().sent.find((p) => p.op === 6), { op: 6, d: { token: BOT_TOKEN, session_id: 'sess1', seq: 1 } });
    ws().recv({ op: 0, t: 'RESUMED', s: 2, d: {} });
    assert.equal(gw.status().state, 'ready');
  });

  it('hands MESSAGE_CREATE to the handler with the bot\'s own id', async () => {
    ready();
    ws().recv({ op: 0, t: 'MESSAGE_CREATE', s: 2, d: { id: '1' } });
    await new Promise(setImmediate);
    assert.deepEqual(received, [{ d: { id: '1' }, ctx: { selfId: SELF } }]);
  });

  it('keeps a failing handler from ending the process', async () => {
    const g = gateway.createGateway({ token: 't', WebSocket: FakeWS, timers, log: logs.log, onMessageCreate: async () => { throw new Error('x'); } });
    g.start();
    ws().recv({ op: 0, t: 'MESSAGE_CREATE', d: {} });
    await new Promise(setImmediate);
    assert.ok(logs.codes().includes('inbound-handler-failed'));
    g.stop();
  });

  it('reconnects on op 7 and resumes', () => {
    ready();
    ws().recv({ op: 7 });
    timers.fire();
    ws().recv({ op: 10, d: { heartbeat_interval: 40000 } });
    assert.ok(ws().sent.some((p) => p.op === 6));
  });

  it('identifies afresh after a non-resumable invalid session, after a one-to-five-second pause', () => {
    ready();
    ws().recv({ op: 9, d: false });
    const wait = timers.fire();
    assert.ok(wait >= 1000 && wait <= 5000);
    ws().recv({ op: 10, d: { heartbeat_interval: 40000 } });
    assert.ok(ws().sent.some((p) => p.op === 2));
    assert.ok(!ws().sent.some((p) => p.op === 6));
  });

  it('identifies afresh after a close that ends the session', () => {
    ready();
    ws().serverClose(4009);
    timers.fire();
    assert.equal(ws().url, gateway.DEFAULT_URL);
    ws().recv({ op: 10, d: { heartbeat_interval: 40000 } });
    assert.ok(ws().sent.some((p) => p.op === 2));
  });

  for (const code of [4004, 4014]) {
    it(`stops for good on close ${code} rather than spending identifies`, () => {
      ready();
      ws().serverClose(code);
      assert.equal(timers.list.size, 0, 'no reconnect is scheduled');
      assert.deepEqual(gw.status(), { state: 'fatal', fatalCloseCode: code, resumable: true, reconnectAttempts: 0 });
      assert.ok(logs.codes().includes('gateway-fatal'));
    });
  }

  it('backs off exponentially with jitter up to the cap, and resets once ready', () => {
    gw.start();
    const waits = [];
    for (let i = 0; i < 6; i++) {
      ws().serverClose(1006);
      waits.push(timers.fire());
    }
    assert.deepEqual(waits, [750, 1500, 3000, 6000, 6000, 6000]);
    ws().recv({ op: 10, d: { heartbeat_interval: 40000 } });
    ws().recv({ op: 0, t: 'READY', s: 1, d: { session_id: 's', resume_gateway_url: 'wss://r.test' } });
    assert.equal(gw.status().reconnectAttempts, 0);
  });

  it('never puts the token in its log or status', () => {
    ready();
    ws().serverClose(1006);
    timers.fire();
    assert.doesNotMatch(logs.lines.join('\n') + JSON.stringify(gw.status()), /bot-token-secret/);
  });

  it('connects where Discord says, once asked, and falls back to the default when asking fails', async () => {
    const answers = ['wss://gateway-us-east1.discord.gg', new Error('down'), 'http://evil.test'];
    for (const [answer, expected] of [
      [answers[0], 'wss://gateway-us-east1.discord.gg/?v=10&encoding=json'],
      [answers[1], gateway.DEFAULT_URL],
      [answers[2], gateway.DEFAULT_URL]
    ]) {
      let asked = 0;
      const g = gateway.createGateway({
        token: 't', WebSocket: FakeWS, timers, log: () => {}, onMessageCreate: () => {},
        getUrl: async () => { asked += 1; if (answer instanceof Error) throw answer; return answer; }
      });
      g.start();
      await new Promise(setImmediate);
      assert.equal(ws().url, expected);
      ws().serverClose(1006);
      timers.fire();
      await new Promise(setImmediate);
      assert.equal(asked, answer === answers[0] ? 1 : 2, 'a good answer is cached; a failed one is asked again');
      g.stop();
    }
  });

  it('stops cleanly: closes with 1000 and schedules nothing', () => {
    ready();
    const s = ws();
    gw.stop();
    assert.equal(s.closedWith, 1000);
    assert.equal(timers.list.size, 0);
  });
});
