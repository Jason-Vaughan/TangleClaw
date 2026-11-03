'use strict';

// #2394 (v5.59.0 Wave 1 Car 59-D, Architect Ruling A2394): multi-channel
// watch inventory, bounded untrusted watch ingestion, and the scoped
// publication-grant contract, via `lib/bridge-channels.js`. A fresh temp
// store per test, no mocks of the module under test.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const bc = require('../lib/bridge-channels');

let tmpDir;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-bridge-channels-'));
  store._setBasePath(tmpDir);
  store.init();
});

afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** A minimal, fully-valid channel registration; override per test. */
function validChannel(overrides = {}) {
  return { channelId: 'ch1', guildId: 'g1', name: 'general', mode: 'watch-only', ...overrides };
}

describe('registerChannel / updateChannel / getChannel / listChannels', () => {
  it('registers a channel with the given mode and sendAllowed', () => {
    const r = bc.registerChannel(validChannel({ sendAllowed: true, mode: 'two-way' }));
    assert.equal(r.ok, true);
    assert.equal(r.channel.mode, 'two-way');
    assert.equal(r.channel.sendAllowed, true);
  });

  it('defaults sendAllowed to false', () => {
    const r = bc.registerChannel(validChannel());
    assert.equal(r.channel.sendAllowed, false);
  });

  it('refuses a missing channelId, guildId, name, or an unknown mode', () => {
    assert.equal(bc.registerChannel(validChannel({ channelId: '' })).ok, false);
    assert.equal(bc.registerChannel(validChannel({ guildId: '' })).ok, false);
    assert.equal(bc.registerChannel(validChannel({ name: '' })).ok, false);
    assert.equal(bc.registerChannel(validChannel({ mode: 'read-write' })).ok, false);
  });

  it('allThreads is refused without the operator\'s explicit approval', () => {
    const r = bc.registerChannel(validChannel({ allThreads: true }));
    assert.equal(r.ok, false);
    assert.equal(r.code, 'BRIDGE_CHANNEL_ALL_THREADS_NOT_APPROVED');
  });

  it('allThreads succeeds once operatorApprovedAllThreads is explicit', () => {
    const r = bc.registerChannel(validChannel({ allThreads: true, operatorApprovedAllThreads: true }));
    assert.equal(r.ok, true);
    assert.equal(r.channel.allThreads, true);
  });

  it('threadIds must be a non-empty array of strings', () => {
    assert.equal(bc.registerChannel(validChannel({ threadIds: [] })).ok, false);
    assert.equal(bc.registerChannel(validChannel({ threadIds: [1, 2] })).ok, false);
    assert.equal(bc.registerChannel(validChannel({ threadIds: 'nope' })).ok, false);
    const r = bc.registerChannel(validChannel({ threadIds: ['t1', 't2'] }));
    assert.equal(r.ok, true);
    assert.deepEqual(r.channel.threadIds, ['t1', 't2']);
  });

  it('threadIds and allThreads are mutually exclusive', () => {
    const r = bc.registerChannel(validChannel({ threadIds: ['t1'], allThreads: true, operatorApprovedAllThreads: true }));
    assert.equal(r.ok, false);
    assert.equal(r.code, 'BRIDGE_CHANNEL_INVALID');
  });

  it('re-registering the same channelId upserts rather than duplicating', () => {
    bc.registerChannel(validChannel({ name: 'first' }));
    bc.registerChannel(validChannel({ name: 'second' }));
    assert.equal(bc.listChannels().length, 1);
    assert.equal(bc.getChannel('ch1').name, 'second');
  });

  it('updateChannel changes only the named fields, re-validated against the merged result', () => {
    bc.registerChannel(validChannel({ sendAllowed: false }));
    const r = bc.updateChannel('ch1', { sendAllowed: true });
    assert.equal(r.ok, true);
    assert.equal(r.channel.sendAllowed, true);
    assert.equal(r.channel.mode, 'watch-only', 'untouched fields are preserved');
  });

  it('updateChannel refuses a merged result that would itself be invalid', () => {
    bc.registerChannel(validChannel({ threadIds: ['t1'] }));
    const r = bc.updateChannel('ch1', { allThreads: true, operatorApprovedAllThreads: true });
    assert.equal(r.ok, false, 'the existing threadIds still conflict with the new allThreads');
  });

  it('updateChannel refuses an unknown channel', () => {
    const r = bc.updateChannel('no-such-channel', { sendAllowed: true });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'NOT_FOUND');
  });

  it('listChannels sorts by name', () => {
    bc.registerChannel(validChannel({ channelId: 'b', name: 'Bravo' }));
    bc.registerChannel(validChannel({ channelId: 'a', name: 'Alpha' }));
    assert.deepEqual(bc.listChannels().map((c) => c.name), ['Alpha', 'Bravo']);
  });
});

describe('recordWatchedMessage — bounded, explicitly untrusted ingestion', () => {
  it('always records authority watched-untrusted, including for the Operator\'s own message', () => {
    bc.registerChannel(validChannel());
    const r = bc.recordWatchedMessage({ messageId: 'm1', channelId: 'ch1', authorLabel: 'operator', sourceLabel: 'discord', text: 'hi' });
    assert.equal(r.ok, true);
    assert.equal(r.message.authority, 'watched-untrusted');
    assert.equal(r.message.authorLabel, 'operator');
  });

  it('refuses a message for an unregistered channel', () => {
    const r = bc.recordWatchedMessage({ messageId: 'm1', channelId: 'no-such', authorLabel: 'x', sourceLabel: 'discord' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'NOT_FOUND');
  });

  it('refuses a thread outside the channel\'s forum scope', () => {
    bc.registerChannel(validChannel({ threadIds: ['t1'] }));
    const r = bc.recordWatchedMessage({ messageId: 'm1', channelId: 'ch1', threadId: 't2', authorLabel: 'x', sourceLabel: 'discord' });
    assert.equal(r.ok, false);
    assert.equal(r.code, 'BRIDGE_CHANNEL_OUT_OF_SCOPE');
  });

  it('accepts a thread named in the explicit allowlist', () => {
    bc.registerChannel(validChannel({ threadIds: ['t1'] }));
    const r = bc.recordWatchedMessage({ messageId: 'm1', channelId: 'ch1', threadId: 't1', authorLabel: 'x', sourceLabel: 'discord' });
    assert.equal(r.ok, true);
  });

  it('accepts any thread once allThreads is operator-approved', () => {
    bc.registerChannel(validChannel({ allThreads: true, operatorApprovedAllThreads: true }));
    const r = bc.recordWatchedMessage({ messageId: 'm1', channelId: 'ch1', threadId: 'anything', authorLabel: 'x', sourceLabel: 'discord' });
    assert.equal(r.ok, true);
  });

  it('a top-level (non-thread) message is always in scope', () => {
    bc.registerChannel(validChannel({ threadIds: ['t1'] }));
    const r = bc.recordWatchedMessage({ messageId: 'm1', channelId: 'ch1', authorLabel: 'x', sourceLabel: 'discord' });
    assert.equal(r.ok, true);
  });

  it('respects a custom retentionMs for the expiry bound', () => {
    bc.registerChannel(validChannel());
    const r = bc.recordWatchedMessage({ messageId: 'm1', channelId: 'ch1', authorLabel: 'x', sourceLabel: 'discord', retentionMs: 1000 });
    const ageMs = Date.parse(r.message.expiresAt) - Date.parse(r.message.receivedAt);
    assert.equal(ageMs, 1000);
  });

  it('this module exposes no function that promotes a watched message into a route, answer, candidate or approval', () => {
    const exported = Object.keys(bc);
    for (const name of exported) {
      assert.ok(!/route|answer|candidate|approv/i.test(name), `"${name}" looks like a promotion path -- #2394 forbids one`);
    }
  });
});

describe('listWatchedMessages / pruneExpiredWatchedMessages', () => {
  it('lists newest first, optionally scoped to a channel', () => {
    bc.registerChannel(validChannel());
    bc.registerChannel(validChannel({ channelId: 'ch2', name: 'other' }));
    bc.recordWatchedMessage({ messageId: 'm1', channelId: 'ch1', authorLabel: 'x', sourceLabel: 'discord' });
    bc.recordWatchedMessage({ messageId: 'm2', channelId: 'ch2', authorLabel: 'x', sourceLabel: 'discord' });
    assert.deepEqual(bc.listWatchedMessages({ channelId: 'ch1' }).map((m) => m.messageId), ['m1']);
    assert.equal(bc.listWatchedMessages().length, 2);
  });

  it('prunes only messages past their own expiry', () => {
    bc.registerChannel(validChannel());
    bc.recordWatchedMessage({ messageId: 'm1', channelId: 'ch1', authorLabel: 'x', sourceLabel: 'discord', retentionMs: 1000 });
    bc.recordWatchedMessage({ messageId: 'm2', channelId: 'ch1', authorLabel: 'x', sourceLabel: 'discord', retentionMs: 1000 * 60 * 60 * 24 * 365 });
    const deleted = bc.pruneExpiredWatchedMessages({ at: new Date(Date.now() + 2000).toISOString() });
    assert.equal(deleted, 1);
    assert.deepEqual(bc.listWatchedMessages().map((m) => m.messageId), ['m2']);
  });

  it('never serves an expired message, even with no explicit prune call (PRR-A I-Gate Round 1 Finding 2)', () => {
    bc.registerChannel(validChannel());
    const real = bc._internal.now;
    try {
      bc._internal.now = () => '2026-01-01T00:00:00.000Z';
      bc.recordWatchedMessage({ messageId: 'm1', channelId: 'ch1', authorLabel: 'x', sourceLabel: 'discord', retentionMs: 1000 });
      bc._internal.now = () => '2026-01-01T00:00:03.000Z';
      // No pruneExpiredWatchedMessages() call anywhere in this test -- the
      // read itself must exclude the expired row.
      assert.deepEqual(bc.listWatchedMessages(), []);
      assert.deepEqual(bc.listWatchedMessages({ channelId: 'ch1' }), []);
    } finally {
      bc._internal.now = real;
    }
  });

  it('recordWatchedMessage itself sweeps expired rows, as a defined pruning boundary (PRR-A I-Gate Round 1 Finding 2)', () => {
    bc.registerChannel(validChannel());
    const real = bc._internal.now;
    try {
      bc._internal.now = () => '2026-01-01T00:00:00.000Z';
      bc.recordWatchedMessage({ messageId: 'm1', channelId: 'ch1', authorLabel: 'x', sourceLabel: 'discord', retentionMs: 1000 });
      bc._internal.now = () => '2026-01-01T00:00:03.000Z';
      bc.recordWatchedMessage({ messageId: 'm2', channelId: 'ch1', authorLabel: 'x', sourceLabel: 'discord' });
      // m1 is gone from storage entirely (not merely filtered on read) --
      // the second write is the boundary that swept it.
      const raw = store.getDb().prepare('SELECT message_id FROM bridge_watched_messages').all().map((r) => r.message_id);
      assert.deepEqual(raw, ['m2']);
    } finally {
      bc._internal.now = real;
    }
  });
});

describe('createPublicationGrant', () => {
  function grantInput(overrides = {}) {
    return {
      destinationChannelId: 'ch1', textSha256: 'a'.repeat(64), operatorRouteId: 'route-1', idempotencyKey: 'idem-1', ...overrides
    };
  }

  it('refuses a channel that does not allow sending', () => {
    bc.registerChannel(validChannel({ sendAllowed: false }));
    const r = bc.createPublicationGrant(grantInput());
    assert.equal(r.ok, false);
    assert.equal(r.code, 'BRIDGE_CHANNEL_SEND_NOT_ALLOWED');
  });

  it('refuses an unknown channel', () => {
    const r = bc.createPublicationGrant(grantInput());
    assert.equal(r.ok, false);
    assert.equal(r.code, 'NOT_FOUND');
  });

  it('succeeds on a sendAllowed channel', () => {
    bc.registerChannel(validChannel({ sendAllowed: true }));
    const r = bc.createPublicationGrant(grantInput());
    assert.equal(r.ok, true);
    assert.equal(r.grant.state, 'pending');
    assert.equal(r.replayed, false);
  });

  it('refuses a malformed textSha256', () => {
    bc.registerChannel(validChannel({ sendAllowed: true }));
    assert.equal(bc.createPublicationGrant(grantInput({ textSha256: 'not-hex' })).ok, false);
    assert.equal(bc.createPublicationGrant(grantInput({ textSha256: 'a'.repeat(63) })).ok, false);
  });

  it('idempotent: an identical repeat replays the first grant', () => {
    bc.registerChannel(validChannel({ sendAllowed: true }));
    const r1 = bc.createPublicationGrant(grantInput());
    const r2 = bc.createPublicationGrant(grantInput());
    assert.equal(r2.replayed, true);
    assert.equal(r2.grant.grantId, r1.grant.grantId);
  });

  it('refuses the same idempotencyKey bound to different fields as a conflict', () => {
    bc.registerChannel(validChannel({ sendAllowed: true }));
    bc.createPublicationGrant(grantInput());
    const r = bc.createPublicationGrant(grantInput({ textSha256: 'b'.repeat(64) }));
    assert.equal(r.ok, false);
    assert.equal(r.code, 'BRIDGE_GRANT_IDEMPOTENCY_CONFLICT');
  });
});

describe('checkPublicationGrant — read-only preflight, before a helper posts (PRR-A I-Gate Round 1 Finding 1)', () => {
  function grantInput(overrides = {}) {
    return {
      destinationChannelId: 'ch1', textSha256: 'a'.repeat(64), operatorRouteId: 'route-1', idempotencyKey: 'idem-1', ...overrides
    };
  }

  beforeEach(() => {
    bc.registerChannel(validChannel({ sendAllowed: true }));
    bc.createPublicationGrant(grantInput());
  });

  it('succeeds for a pending, unexpired grant on a sendAllowed channel, and mutates nothing', () => {
    const r = bc.checkPublicationGrant(grantInput());
    assert.equal(r.ok, true);
    assert.equal(r.grant.state, 'pending');
    assert.equal(r.grant.outcome, null);
    // Still pending after the preflight -- a check is not a consume.
    assert.equal(bc.checkPublicationGrant(grantInput()).grant.state, 'pending');
  });

  it('refuses an unknown idempotencyKey', () => {
    assert.equal(bc.checkPublicationGrant(grantInput({ idempotencyKey: 'no-such' })).code, 'NOT_FOUND');
  });

  it('refuses a presented post that does not match the grant exactly', () => {
    assert.equal(bc.checkPublicationGrant(grantInput({ textSha256: 'b'.repeat(64) })).code, 'BRIDGE_GRANT_MISMATCH');
  });

  it('refuses a grant already consumed with a confirmed outcome', () => {
    bc.validateAndConsumePublicationGrant({ ...grantInput(), outcome: 'posted' });
    const r = bc.checkPublicationGrant(grantInput());
    assert.equal(r.ok, false);
    assert.equal(r.code, 'BRIDGE_GRANT_ALREADY_CONSUMED');
    assert.equal(r.outcome, 'posted');
  });

  it('refuses an expired, never-attempted grant', () => {
    const real = bc._internal.now;
    try {
      bc.createPublicationGrant({ ...grantInput({ idempotencyKey: 'idem-2' }), ttlMs: 1000 });
      bc._internal.now = () => new Date(Date.now() + 2000).toISOString();
      assert.equal(bc.checkPublicationGrant(grantInput({ idempotencyKey: 'idem-2' })).code, 'BRIDGE_GRANT_EXPIRED');
    } finally {
      bc._internal.now = real;
    }
  });

  it('refuses a pending grant once the channel\'s sendAllowed is revoked AFTER the grant was created', () => {
    assert.equal(bc.checkPublicationGrant(grantInput()).ok, true, 'sanity: granted while sendAllowed');
    bc.updateChannel('ch1', { sendAllowed: false });
    const r = bc.checkPublicationGrant(grantInput());
    assert.equal(r.ok, false);
    assert.equal(r.code, 'BRIDGE_CHANNEL_SEND_NOT_ALLOWED');
  });

  it('a grant revoked by sendAllowed still consumes normally once re-allowed -- the preflight is the gate, not a frozen snapshot', () => {
    bc.updateChannel('ch1', { sendAllowed: false });
    assert.equal(bc.checkPublicationGrant(grantInput()).ok, false);
    bc.updateChannel('ch1', { sendAllowed: true });
    assert.equal(bc.checkPublicationGrant(grantInput()).ok, true);
  });

  it('refuses a new post attempt once the grant\'s own TTL closes, even after an "unknown" outcome was recorded (PRR-A I-Gate Round 2 Finding)', () => {
    const real = bc._internal.now;
    try {
      const t0 = Date.now();
      bc._internal.now = () => new Date(t0).toISOString();
      bc.createPublicationGrant({ ...grantInput({ idempotencyKey: 'idem-4' }), ttlMs: 1000 });
      const unknown = bc.validateAndConsumePublicationGrant({ ...grantInput({ idempotencyKey: 'idem-4' }), outcome: 'unknown' });
      assert.equal(unknown.ok, true);
      assert.equal(unknown.grant.state, 'pending', 'sanity: unknown never consumes');

      bc._internal.now = () => new Date(t0 + 2000).toISOString();
      // Settling the already-recorded uncertainty is still allowed, past the TTL.
      const settle = bc.validateAndConsumePublicationGrant({ ...grantInput({ idempotencyKey: 'idem-4' }), outcome: 'posted' });
      assert.equal(settle.ok, true, 'resolving the recorded uncertainty is never time-boxed');

      // But a FRESH grant, never settled, must not authorize a NEW post attempt past its own TTL.
      bc._internal.now = () => new Date(t0).toISOString();
      bc.createPublicationGrant({ ...grantInput({ idempotencyKey: 'idem-5' }), ttlMs: 1000 });
      bc.validateAndConsumePublicationGrant({ ...grantInput({ idempotencyKey: 'idem-5' }), outcome: 'unknown' });
      bc._internal.now = () => new Date(t0 + 2000).toISOString();
      const preflight = bc.checkPublicationGrant(grantInput({ idempotencyKey: 'idem-5' }));
      assert.equal(preflight.ok, false, 'an "unknown" outcome must not let pre-send authorization outlive the TTL');
      assert.equal(preflight.code, 'BRIDGE_GRANT_EXPIRED');
    } finally {
      bc._internal.now = real;
    }
  });
});

describe('validateAndConsumePublicationGrant', () => {
  function grantInput(overrides = {}) {
    return {
      destinationChannelId: 'ch1', textSha256: 'a'.repeat(64), operatorRouteId: 'route-1', idempotencyKey: 'idem-1', ...overrides
    };
  }

  function consumeInput(overrides = {}) {
    return { idempotencyKey: 'idem-1', destinationChannelId: 'ch1', textSha256: 'a'.repeat(64), operatorRouteId: 'route-1', outcome: 'posted', ...overrides };
  }

  beforeEach(() => {
    bc.registerChannel(validChannel({ sendAllowed: true }));
    bc.createPublicationGrant(grantInput());
  });

  it('refuses an unknown idempotencyKey', () => {
    const r = bc.validateAndConsumePublicationGrant(consumeInput({ idempotencyKey: 'no-such' }));
    assert.equal(r.ok, false);
    assert.equal(r.code, 'NOT_FOUND');
  });

  it('refuses a presented post that does not match the grant exactly', () => {
    assert.equal(bc.validateAndConsumePublicationGrant(consumeInput({ textSha256: 'b'.repeat(64) })).code, 'BRIDGE_GRANT_MISMATCH');
    assert.equal(bc.validateAndConsumePublicationGrant(consumeInput({ destinationChannelId: 'ch2' })).code, 'BRIDGE_GRANT_MISMATCH');
    assert.equal(bc.validateAndConsumePublicationGrant(consumeInput({ operatorRouteId: 'route-2' })).code, 'BRIDGE_GRANT_MISMATCH');
  });

  it('refuses an unknown outcome', () => {
    const r = bc.validateAndConsumePublicationGrant(consumeInput({ outcome: 'maybe' }));
    assert.equal(r.ok, false);
    assert.equal(r.code, 'BRIDGE_GRANT_INVALID');
  });

  it('a confirmed outcome (posted/failed) consumes the grant', () => {
    const r = bc.validateAndConsumePublicationGrant(consumeInput({ outcome: 'posted' }));
    assert.equal(r.ok, true);
    assert.equal(r.grant.state, 'consumed');
    assert.equal(r.grant.outcome, 'posted');
    assert.equal(typeof r.grant.consumedAt, 'string');
  });

  it('a confirmed outcome never re-evaluates on a repeat -- idempotent readback', () => {
    bc.validateAndConsumePublicationGrant(consumeInput({ outcome: 'posted' }));
    const r = bc.validateAndConsumePublicationGrant(consumeInput({ outcome: 'failed' }));
    assert.equal(r.ok, true);
    assert.equal(r.grant.outcome, 'posted', 'the first confirmed outcome stands; the second call is a pure readback');
  });

  it('an "unknown" outcome does not consume the grant, so a later confirmed outcome may still settle it', () => {
    const r1 = bc.validateAndConsumePublicationGrant(consumeInput({ outcome: 'unknown' }));
    assert.equal(r1.grant.state, 'pending');
    assert.equal(r1.grant.outcome, 'unknown');
    const r2 = bc.validateAndConsumePublicationGrant(consumeInput({ outcome: 'posted' }));
    assert.equal(r2.ok, true);
    assert.equal(r2.grant.state, 'consumed');
    assert.equal(r2.grant.outcome, 'posted');
  });

  it('a fresh, never-attempted grant expires after its TTL', () => {
    const real = bc._internal.now;
    try {
      bc.createPublicationGrant({ ...grantInput({ idempotencyKey: 'idem-2' }), ttlMs: 1000 });
      bc._internal.now = () => new Date(Date.now() + 2000).toISOString();
      const r = bc.validateAndConsumePublicationGrant(consumeInput({ idempotencyKey: 'idem-2' }));
      assert.equal(r.ok, false);
      assert.equal(r.code, 'BRIDGE_GRANT_EXPIRED');
    } finally {
      bc._internal.now = real;
    }
  });

  it('expiry does not block resolving an "unknown" outcome recorded before the window closed', () => {
    const real = bc._internal.now;
    try {
      bc.createPublicationGrant({ ...grantInput({ idempotencyKey: 'idem-3' }), ttlMs: 1000 });
      bc.validateAndConsumePublicationGrant(consumeInput({ idempotencyKey: 'idem-3', outcome: 'unknown' }));
      bc._internal.now = () => new Date(Date.now() + 2000).toISOString();
      const r = bc.validateAndConsumePublicationGrant(consumeInput({ idempotencyKey: 'idem-3', outcome: 'posted' }));
      assert.equal(r.ok, true, 'resolving a recorded uncertainty is never time-boxed by the original TTL');
    } finally {
      bc._internal.now = real;
    }
  });
});
