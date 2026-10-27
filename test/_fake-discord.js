'use strict';

// A stand-in for Discord, for the bridge helper's tests (#2031): the three
// REST calls the helper makes, served over real HTTP, and a WebSocket the
// test scripts by hand. It keeps Discord's own promise about nonces: a post
// repeated with the same nonce returns the message already made.

const http = require('node:http');

/**
 * Start a fake Discord REST API.
 * @returns {Promise<{api: string, posts: object[], reactions: string[], script: object[], reads: object, calls: function(): number, close: function(): Promise<void>}>}
 *   `posts` is every message made, in order. `script` is consumed one entry
 *   per POST: `{status, body}` answers without posting, and `{status, lands:
 *   true}` posts and then answers with that status, which is what a timeout
 *   after the fact looks like. `onlyThreaded: true` keeps an entry for the
 *   next post that names a message to reply to.
 */
async function startFakeDiscord() {
  const posts = [];
  const reactions = [];
  const script = [];
  const byNonce = new Map();
  // `channelsById` (#2433) answers a specific channel id differently from
  // every other one -- needed once a test juggles the guild channel and the
  // pinned DM channel at the same time, each with its own shape. Checked
  // before the single `channel` stub, which still answers every id alike.
  const reads = { self: [200, { id: '900000000000000009', bot: true }], channel: null, channelsById: {}, guildId: '200000000000000002' };
  let postCalls = 0;
  let nextId = 400000000000000000n;

  /**
   * Make a message, or return the one a repeated nonce already made.
   * @param {string} channelId - Channel.
   * @param {object} body - The request body.
   * @returns {{id: string}}
   */
  const make = (channelId, body) => {
    if (body.enforce_nonce && byNonce.has(body.nonce)) return { id: byNonce.get(body.nonce) };
    const id = String(++nextId);
    posts.push({
      id, channelId, content: body.content, nonce: body.nonce,
      replyTo: body.message_reference ? body.message_reference.message_id : null,
      allowedMentions: body.allowed_mentions
    });
    if (body.enforce_nonce) byNonce.set(body.nonce, id);
    return { id };
  };

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', () => {
      const answer = (status, body) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(body === undefined ? '' : JSON.stringify(body));
      };
      const post = /^\/channels\/(\d+)\/messages$/.exec(req.url);
      if (req.method === 'POST' && post) {
        postCalls += 1;
        const body = JSON.parse(raw);
        // An entry marked `onlyThreaded` answers a post that names a message
        // to reply to, and waits for one: a post that names none passes it by.
        const scripted = script[0] && script[0].onlyThreaded && !body.message_reference ? null : script.shift();
        if (scripted) {
          if (scripted.lands) make(post[1], body);
          return answer(scripted.status, scripted.body || {});
        }
        return answer(200, make(post[1], body));
      }
      if (req.method === 'PUT' && /\/reactions\//.test(req.url)) {
        reactions.push(decodeURIComponent(req.url));
        return answer(204);
      }
      if (req.method === 'GET' && req.url === '/gateway/bot') return answer(200, { url: 'wss://gateway-test.discord.gg' });
      // The two read-only calls preflight makes. `reads` holds what each answers with.
      if (req.method === 'GET' && req.url === '/users/@me') return answer(...reads.self);
      const channel = /^\/channels\/(\d+)$/.exec(req.url);
      if (req.method === 'GET' && channel) {
        return answer(...(reads.channelsById[channel[1]] || reads.channel || [200, { id: channel[1], guild_id: reads.guildId, type: 0 }]));
      }
      return answer(404, { code: 0 });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    api: `http://127.0.0.1:${server.address().port}`, posts, reactions, script, reads,
    /** @returns {number} How many times a post was asked for, whatever the answer. */
    calls: () => postCalls,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

/**
 * A WebSocket class the test drives. Every socket made is in `sockets`; the
 * test delivers Gateway payloads with `receive` and reads what the client
 * sent from `sent`.
 * @returns {{WebSocket: Function, sockets: object[]}}
 */
function fakeWebSocket() {
  const sockets = [];
  class FakeWebSocket {
    /** @param {string} url - Where the client connected. */
    constructor(url) {
      this.url = url;
      this.readyState = 1;
      this.sent = [];
      this.closedWith = null;
      this.listeners = { message: new Set(), close: new Set(), error: new Set() };
      sockets.push(this);
    }

    /** @param {string} type - Event name. @param {Function} fn - Handler. @returns {void} */
    addEventListener(type, fn) { this.listeners[type].add(fn); }

    /** @param {string} type - Event name. @param {Function} fn - Handler. @returns {void} */
    removeEventListener(type, fn) { this.listeners[type].delete(fn); }

    /** @param {string} data - A frame the client sent. @returns {void} */
    send(data) { this.sent.push(JSON.parse(data)); }

    /** @param {number} code - Close code the client sent. @returns {void} */
    close(code) { this.readyState = 3; this.closedWith = code; }

    /** @param {object} payload - A Gateway payload from Discord. @returns {void} */
    receive(payload) { for (const fn of this.listeners.message) fn({ data: JSON.stringify(payload) }); }

    /** @param {number} code - Close code from Discord. @returns {void} */
    drop(code) { this.readyState = 3; for (const fn of this.listeners.close) fn({ code }); }
  }
  return { WebSocket: FakeWebSocket, sockets };
}

module.exports = { startFakeDiscord, fakeWebSocket };
