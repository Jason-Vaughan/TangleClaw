'use strict';

// #2433: the helper's inbound filter (`createInbound`/`isOperatorMessage`)
// admits a second, independently-enabled pinned ingress surface -- one DM
// channel from the same verified author -- alongside the existing pinned
// guild channel, and rejects every other DM shape before reading content.
// Unlike `test/bridge-helper-relay.test.js` (the real server, a real HTTP
// bridge client, a fake Discord REST server), this file drives
// `createInbound` directly with hand-made fakes: fast, and isolated to this
// one module's own filtering logic.

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createInbound, REFUSAL_TEXT } = require('../lib/bridge-helper/inbound');

const IDS = { authorId: '100000000000000001', guildId: '200000000000000002', channelId: '300000000000000003' };
const DM_ID = '300000000000000099';
const BOT_ID = '900000000000000009';

let messageSeq = 600000000000000000n;

/**
 * A guild MESSAGE_CREATE as Discord delivers it, from the allowlisted author.
 * @param {object} [over] - Overrides.
 * @returns {object}
 */
function message(over = {}) {
  return { id: String(++messageSeq), type: 0, author: { id: IDS.authorId }, guild_id: IDS.guildId, channel_id: IDS.channelId, content: 'hi', ...over };
}

/**
 * A DM MESSAGE_CREATE: like a guild one, but with no `guild_id` at all --
 * which is what tells the two surfaces apart -- and on the pinned DM channel.
 * @param {object} [over] - Overrides.
 * @returns {object}
 */
function dmMessage(over = {}) {
  const d = message({ channel_id: DM_ID, ...over });
  delete d.guild_id;
  return d;
}

describe('bridge helper: inbound filtering and the DM surface (#2433)', () => {
  let sent, posts, reactions, codes, allow;

  beforeEach(() => {
    sent = [];
    posts = [];
    reactions = [];
    codes = [];
    allow = { authorId: IDS.authorId, guildId: IDS.guildId, channelId: IDS.channelId, dmChannelId: DM_ID, dmEnabled: true };
  });

  /**
   * Make a handler over fresh fakes, with the allowlist this test needs.
   * @param {object} [overAllow] - Allowlist overrides.
   * @returns {function(object, object=): Promise<string>}
   */
  function handler(overAllow = {}) {
    const bridge = { sendInbound: async (m) => { sent.push(m); return { status: 202 }; } };
    const rest = {
      createMessage: async (channelId, body) => { posts.push({ channelId, ...body }); return { id: 'posted' }; },
      addReaction: async (channelId, messageId, emoji) => { reactions.push({ channelId, messageId, emoji }); }
    };
    const log = (code, fields) => codes.push([code, fields || {}]);
    return createInbound({ allow: { ...allow, ...overAllow }, bridge, rest, log, sleep: async () => {} });
  }

  it('accepts a guild message exactly as before the DM surface existed (regression)', async () => {
    const h = handler();
    const code = await h(message());
    assert.equal(code, 'inbound-accepted');
    assert.deepEqual(sent.map((m) => [m.spaceId, m.channelId]), [[IDS.guildId, IDS.channelId]]);
    assert.deepEqual(reactions.map((r) => r.channelId), [IDS.channelId]);
  });

  it('accepts a DM from the pinned author on the pinned DM channel, its space_id the DM channel id too', async () => {
    const h = handler();
    const code = await h(dmMessage());
    assert.equal(code, 'inbound-accepted');
    assert.deepEqual(sent.map((m) => [m.spaceId, m.channelId]), [[DM_ID, DM_ID]]);
    assert.deepEqual(reactions.map((r) => r.channelId), [DM_ID]);
  });

  it('ignores a DM on the pinned channel from the pinned author while the surface is off', async () => {
    const h = handler({ dmEnabled: false });
    assert.equal(await h(dmMessage()), 'inbound-ignored');
    assert.deepEqual(sent, []);
  });

  it('ignores a DM from anyone but the pinned author, before reading content', async () => {
    const h = handler();
    assert.equal(await h(dmMessage({ author: { id: 'someone-else' }, content: 'should never be read' })), 'inbound-ignored');
    assert.deepEqual([sent, posts], [[], []]);
  });

  it('ignores a message on a DM channel that is not the pinned one -- a group DM or any other', async () => {
    const h = handler();
    assert.equal(await h(dmMessage({ channel_id: 'some-other-dm-channel' })), 'inbound-ignored');
  });

  it('ignores a bot\'s or a webhook\'s message on the pinned DM channel, before reading content', async () => {
    const h = handler();
    assert.equal(await h(dmMessage({ author: { id: IDS.authorId, bot: true }, content: 'should never be read' })), 'inbound-ignored');
    assert.equal(await h(dmMessage({ webhook_id: 'wh1', content: 'should never be read' })), 'inbound-ignored');
    assert.deepEqual([sent, posts], [[], []]);
  });

  it('ignores its own messages on the DM channel', async () => {
    const h = handler();
    assert.equal(await h(dmMessage({ author: { id: BOT_ID } }), { selfId: BOT_ID }), 'inbound-ignored');
  });

  it('ignores a DM message type the guild channel would also ignore (not DEFAULT or REPLY)', async () => {
    const h = handler();
    assert.equal(await h(dmMessage({ type: 7 })), 'inbound-ignored', 'a system message, e.g. a recipient-add');
  });

  it('refuses an empty DM with a reply on the DM surface itself, not the guild channel', async () => {
    const h = handler();
    const code = await h(dmMessage({ content: '' }));
    assert.equal(code, 'inbound-refused');
    assert.deepEqual(posts.map((p) => p.channelId), [DM_ID]);
    assert.equal(posts[0].content, REFUSAL_TEXT.EMPTY_MESSAGE);
    assert.deepEqual(sent, []);
  });

  it('a guild refusal still replies on the guild channel (regression)', async () => {
    const h = handler();
    const code = await h(message({ content: '' }));
    assert.equal(code, 'inbound-refused');
    assert.deepEqual(posts.map((p) => p.channelId), [IDS.channelId]);
  });

  it('a reply on the DM surface carries a reply-to-external-id the same way a guild reply does', async () => {
    const h = handler();
    const first = await h(dmMessage());
    assert.equal(first, 'inbound-accepted');
    const repliedTo = sent[0].externalId;
    const code = await h(dmMessage({ id: String(++messageSeq), type: 19, message_reference: { message_id: repliedTo } }));
    assert.equal(code, 'inbound-accepted');
    assert.equal(sent[1].replyToExternalId, repliedTo);
  });
});
