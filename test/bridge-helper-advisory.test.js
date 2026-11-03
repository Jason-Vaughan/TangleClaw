'use strict';

// #2818 (v5.59.0 Wave 1 Car 59-A, Architect Ruling A2817-B): the bridge
// helper's own half of the advisory-only Discord surface -- config
// validation, inbound classification and the anti-loop silencing
// invariant, and outbound channel resolution. `lib/bridge-helper/cli.js`'s
// `verifyAdvisoryChannel` (the REST-backed startup/preflight check) is not
// covered here: it mirrors `verifyDmChannel`, whose own equivalent coverage
// lives in `test/bridge-helper-relay.test.js`'s full fake-Discord harness,
// the natural place to extend if deeper advisory-surface integration
// coverage is wanted.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const config = require('../lib/bridge-helper/config');
const { createInbound, isAdvisoryMessage, mentionsOperatorOrBot, REFUSAL_TEXT } = require('../lib/bridge-helper/inbound');
const { createOutbound } = require('../lib/bridge-helper/outbound');
const { openState } = require('../lib/bridge-helper/state');
const { BridgeError } = require('../lib/bridge-helper/bridge-client');

const IDS = { authorId: '100000000000000001', guildId: '200000000000000002', channelId: '300000000000000003' };
const ADVISORY_ID = '400000000000000004';
const PEER_BOT_ID = '500000000000000005';
const PEER_HUMAN_ID = '600000000000000006';
const ALLOW = {
  authorId: IDS.authorId, guildId: IDS.guildId, channelId: IDS.channelId,
  dmChannelId: null, dmEnabled: false,
  advisoryChannelId: ADVISORY_ID, advisoryAuthorIds: [PEER_BOT_ID, PEER_HUMAN_ID], advisoryEnabled: true
};

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-bridge-helper-advisory-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * A MESSAGE_CREATE as Discord delivers it.
 * @param {string} authorId - Author id.
 * @param {string} content - Text.
 * @param {object} [over] - Overrides.
 * @returns {object}
 */
function message(authorId, content, over = {}) {
  return { id: '700000000000000007', type: 0, author: { id: authorId }, guild_id: IDS.guildId, channel_id: ADVISORY_ID, content, ...over };
}

describe('bridge-helper/config.js: the advisory surface (#2817-A)', () => {
  /** @returns {string} A fresh config file path for one test. */
  function file() {
    return config.paths(tmpDir).config;
  }

  it('defaults to absent/off/empty, so an existing config with none of the fields still passes', () => {
    const v = config.writeConfig(file(), { baseUrl: 'http://127.0.0.1:3102', ...IDS });
    assert.deepEqual([v.advisoryChannelId, v.advisoryAuthorIds, v.advisoryEnabled], [null, [], false]);
  });

  it('refuses an advisoryChannelId equal to the pinned guild channel, or the pinned DM channel', () => {
    assert.throws(() => config.writeConfig(file(), { baseUrl: 'http://127.0.0.1:3102', ...IDS, advisoryChannelId: IDS.channelId }),
      (err) => err instanceof config.ConfigError && err.field === 'advisoryChannelId');
    assert.throws(
      () => config.writeConfig(file(), { baseUrl: 'http://127.0.0.1:3102', ...IDS, dmChannelId: ADVISORY_ID, advisoryChannelId: ADVISORY_ID }),
      (err) => err instanceof config.ConfigError && err.field === 'advisoryChannelId'
    );
  });

  it('refuses advisoryEnabled without a pinned channel and at least one allowlisted author', () => {
    assert.throws(() => config.writeConfig(file(), { baseUrl: 'http://127.0.0.1:3102', ...IDS, advisoryEnabled: true }),
      (err) => err instanceof config.ConfigError && err.field === 'advisoryChannelId');
    assert.throws(
      () => config.writeConfig(file(), { baseUrl: 'http://127.0.0.1:3102', ...IDS, advisoryChannelId: ADVISORY_ID, advisoryAuthorIds: [], advisoryEnabled: true }),
      (err) => err instanceof config.ConfigError && err.field === 'advisoryChannelId'
    );
    const ok = config.writeConfig(file(),
      { baseUrl: 'http://127.0.0.1:3102', ...IDS, advisoryChannelId: ADVISORY_ID, advisoryAuthorIds: [PEER_BOT_ID], advisoryEnabled: true });
    assert.equal(ok.advisoryEnabled, true);
  });

  it('refuses a malformed advisoryChannelId or a malformed id in advisoryAuthorIds', () => {
    assert.throws(() => config.writeConfig(file(), { baseUrl: 'http://127.0.0.1:3102', ...IDS, advisoryChannelId: 'not a snowflake' }),
      (err) => err.field === 'advisoryChannelId');
    assert.throws(() => config.writeConfig(file(), { baseUrl: 'http://127.0.0.1:3102', ...IDS, advisoryAuthorIds: ['not a snowflake'] }),
      (err) => err.field === 'advisoryAuthorIds');
  });
});

describe('isAdvisoryMessage (#2817-A)', () => {
  it('permits a human message from an allowlisted peer author or the operator', () => {
    assert.equal(isAdvisoryMessage(message(PEER_HUMAN_ID, 'hi'), ALLOW, null), true);
    assert.equal(isAdvisoryMessage(message(IDS.authorId, 'hi'), ALLOW, null), true);
  });

  it('permits a BOT author only when that exact id is itself allowlisted', () => {
    assert.equal(isAdvisoryMessage(message(PEER_BOT_ID, 'hi', { author: { id: PEER_BOT_ID, bot: true } }), ALLOW, null), true);
    assert.equal(isAdvisoryMessage(message('900000000000000009', 'hi', { author: { id: '900000000000000009', bot: true } }), ALLOW, null), false);
  });

  it('rejects a human author who is on neither allowlist', () => {
    assert.equal(isAdvisoryMessage(message('900000000000000009', 'hi'), ALLOW, null), false);
  });

  it('rejects a webhook and a self-message before author checks', () => {
    assert.equal(isAdvisoryMessage(message(PEER_HUMAN_ID, 'hi', { webhook_id: '1' }), ALLOW, null), false);
    assert.equal(isAdvisoryMessage(message(PEER_HUMAN_ID, 'hi'), ALLOW, PEER_HUMAN_ID), false);
  });

  it('rejects the wrong guild or the wrong (non-advisory) channel', () => {
    assert.equal(isAdvisoryMessage(message(PEER_HUMAN_ID, 'hi', { guild_id: 'some-other-guild' }), ALLOW, null), false);
    assert.equal(isAdvisoryMessage(message(PEER_HUMAN_ID, 'hi', { channel_id: IDS.channelId }), ALLOW, null), false);
  });

  it('is false whenever advisoryEnabled is false, regardless of every other field', () => {
    assert.equal(isAdvisoryMessage(message(PEER_HUMAN_ID, 'hi'), { ...ALLOW, advisoryEnabled: false }, null), false);
  });
});

describe('mentionsOperatorOrBot (#2817-A I-Gate Round 1 Finding 1 on PR #2859)', () => {
  const SELF_ID = '800000000000000008';

  it('is true when Discord\'s own structured mentions name the operator or the bot', () => {
    assert.equal(mentionsOperatorOrBot(message(PEER_HUMAN_ID, `<@${IDS.authorId}>?`, { mentions: [{ id: IDS.authorId }] }), ALLOW, SELF_ID), true);
    assert.equal(mentionsOperatorOrBot(message(PEER_HUMAN_ID, `<@${SELF_ID}>?`, { mentions: [{ id: SELF_ID }] }), ALLOW, SELF_ID), true);
  });

  it('is true for the literal @master/@tangleclaw names, even with no structured mention', () => {
    assert.equal(mentionsOperatorOrBot(message(PEER_HUMAN_ID, 'hey @master, question'), ALLOW, SELF_ID), true);
    assert.equal(mentionsOperatorOrBot(message(PEER_HUMAN_ID, '@tangleclaw can you help'), ALLOW, SELF_ID), true);
  });

  it('is false for a mention of some unrelated user, or no mention at all', () => {
    assert.equal(mentionsOperatorOrBot(message(PEER_HUMAN_ID, 'hi', { mentions: [{ id: '900000000000000009' }] }), ALLOW, SELF_ID), false);
    assert.equal(mentionsOperatorOrBot(message(PEER_HUMAN_ID, 'just talking'), ALLOW, SELF_ID), false);
  });
});

describe('createInbound: the advisory anti-loop invariant (#2817-A)', () => {
  /**
   * An inbound handler whose bridge refuses every message with the given
   * status/code, and whose rest client records every reply it is asked to post.
   * @param {number} status - HTTP status the bridge answers with.
   * @param {string} refusalCode - A key of REFUSAL_TEXT.
   * @returns {{handle: Function, replies: object[]}}
   */
  function refusingHandler(status, refusalCode) {
    const replies = [];
    const handle = createInbound({
      allow: ALLOW,
      bridge: { sendInbound: async () => { throw new BridgeError(status, refusalCode); } },
      rest: {
        createMessage: async (channelId, body) => { replies.push({ channelId, body }); return { id: 'reply-1' }; },
        addReaction: async () => {}
      },
      log: () => {},
      sleep: async () => {}
    });
    return { handle, replies };
  }

  it('never posts a refusal reply back to a BOT sender -- an automated error reply would trigger it to reply in turn', async () => {
    const { handle, replies } = refusingHandler(403, 'NOT_ALLOWLISTED');
    const code = await handle(message(PEER_BOT_ID, 'hi', { author: { id: PEER_BOT_ID, bot: true } }), {});
    assert.equal(code, 'inbound-refused');
    assert.deepEqual(replies, [], 'silent in Discord for a bot sender');
  });

  it('still tells a human sender why their message was not delivered', async () => {
    const { handle, replies } = refusingHandler(403, 'NOT_ALLOWLISTED');
    const code = await handle(message(PEER_HUMAN_ID, 'hi'), {});
    assert.equal(code, 'inbound-refused');
    assert.equal(replies.length, 1);
    assert.equal(replies[0].body.content, REFUSAL_TEXT.NOT_ALLOWLISTED);
  });

  it('never retries ADVISORY_LOOP_PAUSED or ADVISORY_MENTION_REQUIRED as transient, and stays silent for the bot sender that hit them', async () => {
    let calls = 0;
    const replies = [];
    const handle = createInbound({
      allow: ALLOW,
      bridge: { sendInbound: async () => { calls += 1; throw new BridgeError(429, 'ADVISORY_LOOP_PAUSED'); } },
      rest: { createMessage: async (channelId, body) => { replies.push({ channelId, body }); return { id: 'r' }; }, addReaction: async () => {} },
      log: () => {},
      sleep: async () => { throw new Error('must never sleep/retry a terminal advisory refusal'); }
    });
    const code = await handle(message(PEER_BOT_ID, 'hi', { author: { id: PEER_BOT_ID, bot: true } }), {});
    assert.equal(code, 'inbound-refused');
    assert.equal(calls, 1, 'not retried as transient');
    assert.deepEqual(replies, [], 'silent for the bot sender');
  });

  it('handles an advisory message distinctly from an ordinary operator message, through the same accept path', async () => {
    const sent = [];
    const handle = createInbound({
      allow: ALLOW,
      bridge: { sendInbound: async (m) => { sent.push(m); return { status: 202 }; } },
      rest: { createMessage: async () => ({ id: 'r' }), addReaction: async () => {} },
      log: () => {},
      sleep: async () => {}
    });
    const code = await handle(message(PEER_HUMAN_ID, 'advisory text'), {});
    assert.equal(code, 'inbound-accepted');
    assert.equal(sent.length, 1);
    assert.equal(sent[0].authorId, PEER_HUMAN_ID);
    assert.equal(sent[0].channelId, ADVISORY_ID);
  });

  it('derives mentionsOperator from real Discord mention data and sends it to the bridge -- never a bare unbacked field '
    + '(#2817-A I-Gate Round 1 Finding 1 on PR #2859)', async () => {
    const sent = [];
    const handle = createInbound({
      allow: ALLOW,
      bridge: { sendInbound: async (m) => { sent.push(m); return { status: 202 }; } },
      rest: { createMessage: async () => ({ id: 'r' }), addReaction: async () => {} },
      log: () => {},
      sleep: async () => {}
    });
    await handle(message(PEER_HUMAN_ID, 'no mention here'), {});
    await handle(message(PEER_HUMAN_ID, `<@${IDS.authorId}>, a question`, { id: '700000000000000008', mentions: [{ id: IDS.authorId }] }), {});
    assert.equal(sent.length, 2);
    assert.equal(sent[0].mentionsOperator, false, 'no mention present');
    assert.equal(sent[1].mentionsOperator, true, 'a real Discord mention of the operator, derived by the helper itself');
  });
});

describe('createOutbound: advisory-channel items (#2817-A)', () => {
  it('skips an item whose server-claimed destination disagrees with this run\'s own verified advisory channel, rather than falling back across surfaces', async () => {
    const logs = [];
    const outbound = createOutbound({
      channelId: IDS.channelId, advisoryChannelId: ADVISORY_ID,
      bridge: {
        claim: async () => ({
          items: [{
            outboundId: 1, leaseState: 'live', surfaceKind: 'advisory-channel', destinationChannelId: 'someone-elses-channel',
            leaseId: 'lease-1', expiresAt: new Date(Date.now() + 60000).toISOString()
          }]
        }),
        ack: async () => {}
      },
      rest: { createMessage: async () => { throw new Error('must never be called: the destination mismatch must refuse before posting'); } },
      state: openState(path.join(tmpDir, 'state.json')),
      log: (code, fields) => logs.push([code, fields])
    });
    const result = await outbound.pass();
    assert.equal(result.posted, 0);
    assert.ok(logs.some(([code]) => code === 'outbound-foreign-channel'));
  });

  it('posts an advisory-channel item to the verified advisory channel once the server\'s own claim agrees', async () => {
    const text = 'an advisory reply';
    const digest = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
    const posted = [];
    const outbound = createOutbound({
      channelId: IDS.channelId, advisoryChannelId: ADVISORY_ID,
      bridge: {
        claim: async () => ({
          items: [{
            outboundId: 2, leaseState: 'live', surfaceKind: 'advisory-channel', destinationChannelId: ADVISORY_ID,
            text, digest, postedParts: [], partCount: 1, leaseId: 'lease-2', expiresAt: new Date(Date.now() + 60000).toISOString()
          }]
        }),
        part: async () => {},
        ack: async () => {}
      },
      rest: { createMessage: async (channelId, body) => { posted.push({ channelId, body }); return { id: 'discord-msg-1' }; } },
      state: openState(path.join(tmpDir, 'state2.json')),
      log: () => {}
    });
    const result = await outbound.pass();
    assert.equal(result.posted, 1);
    assert.equal(posted.length, 1);
    assert.equal(posted[0].channelId, ADVISORY_ID);
  });
});
