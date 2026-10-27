'use strict';

// #2031 (ADR 0023): the operator bridge's durable state. A replayed inbound
// message stays one route; a Master credential has one live generation; a
// route write is idempotent on its request id, refused on a stale version and
// audited either way; and a cleared body leaves its record behind.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const bridgeStore = require('../lib/bridge-store');

let tmpDir = null;
const digest = 'a'.repeat(64);

/**
 * A minimal inbound message for `routes.accept`.
 * @param {object} [over] - Field overrides.
 * @returns {object}
 */
function inbound(over = {}) {
  return {
    routeId: 'rt_1', externalId: 'ext-1', authorId: 'author', spaceId: 'space', channelId: 'channel',
    text: 'hello', digest, ...over
  };
}

/**
 * A close decision for `applyRouteWrite`.
 * @param {object} [over] - Field overrides.
 * @returns {object}
 */
function closeWrite(over = {}) {
  return {
    op: 'close', requestId: 'req-00000001', routeId: 'rt_1', expectedVersion: 1,
    actor: 'master', proof: 'master-launch', masterGeneration: 1,
    change: () => ({ set: { state: 'closed', closed_by: 'master', closed_at: '2026-10-04T00:00:00.000Z' } }),
    ...over
  };
}

describe('bridge store (#2031)', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-bridge-store-'));
    store._setBasePath(tmpDir);
    store.init();
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('is disabled until the operator enables it', () => {
    assert.equal(bridgeStore.settings.isEnabled(), false);
    bridgeStore.settings.set('enabled', 'true');
    assert.equal(bridgeStore.settings.isEnabled(), true);
    bridgeStore.settings.set('enabled', 'false');
    assert.equal(bridgeStore.settings.isEnabled(), false);
  });

  it('stores a replayed inbound message once', () => {
    const first = bridgeStore.routes.accept(inbound());
    const again = bridgeStore.routes.accept(inbound({ routeId: 'rt_2' }));
    assert.equal(first.created, true);
    assert.deepEqual([again.created, again.mismatch, again.route.routeId], [false, false, 'rt_1']);
    assert.equal(bridgeStore.routes.list().length, 1);
    assert.deepEqual(bridgeStore.routes.bodies('rt_1').map((b) => b.text), ['hello']);
  });

  it('refuses a known message id that arrives with a different body or from a different place', () => {
    bridgeStore.routes.accept(inbound());
    const other = 'b'.repeat(64);
    for (const change of [
      { text: 'different text', digest: other },
      { authorId: 'someone-else' }, { spaceId: 'other-space' }, { channelId: 'other-channel' },
      { threadId: 'a-thread' }, { replyToExternalId: 'ext-0' },
      { surfaceKind: 'bot-dm' } // #2433: a replay on a different ingress surface is not a replay.
    ]) {
      const result = bridgeStore.routes.accept(inbound({ routeId: 'rt_x', ...change }));
      assert.deepEqual(result, { created: false, mismatch: true, route: null }, JSON.stringify(change));
    }
    assert.equal(bridgeStore.routes.list().length, 1);
    assert.deepEqual(bridgeStore.routes.bodies('rt_1').map((b) => b.text), ['hello']);
  });

  it('stores which pinned ingress surface a route arrived on, defaulting to guild-channel (#2433)', () => {
    const guild = bridgeStore.routes.accept(inbound());
    assert.equal(guild.route.surfaceKind, 'guild-channel', 'the surface before this column existed');

    const dm = bridgeStore.routes.accept(inbound({ routeId: 'rt_2', externalId: 'ext-2', surfaceKind: 'bot-dm' }));
    assert.equal(dm.route.surfaceKind, 'bot-dm');

    // A replay (same external id, same surface) is still the same route, unaffected.
    const again = bridgeStore.routes.accept(inbound({ routeId: 'rt_2', externalId: 'ext-2', surfaceKind: 'bot-dm' }));
    assert.deepEqual([again.created, again.mismatch, again.route.surfaceKind], [false, false, 'bot-dm']);

    // An outbound item bound to a DM route inherits that route's surface; a routeless one keeps guild-channel.
    const reply = bridgeStore.outbound.enqueue({
      idemKey: 'reply:rt_2', kind: 'reply', routeId: 'rt_2', releasedGeneration: 1,
      sourceLabel: 'TangleClaw', text: 'hi', digest
    });
    assert.equal(reply.surfaceKind, 'bot-dm');

    const notice = bridgeStore.outbound.enqueue({
      idemKey: 'notice:1', kind: 'notification', notifyType: 'fleet-idle',
      sourceLabel: 'TangleClaw', text: 'idle', digest
    });
    assert.equal(notice.surfaceKind, 'guild-channel', 'a routeless notification keeps the original guild-only policy');
  });

  it('keeps one live Master generation and revokes the one before it', () => {
    const g1 = bridgeStore.masterCredentials.mint('b'.repeat(64));
    assert.equal(bridgeStore.masterCredentials.findActive('b'.repeat(64)), null, 'pending is not active');
    assert.equal(bridgeStore.masterCredentials.activate(g1, 'b'.repeat(64)), true);
    assert.equal(bridgeStore.masterCredentials.findActive('b'.repeat(64)).generation, g1);

    const g2 = bridgeStore.masterCredentials.mint('c'.repeat(64));
    assert.equal(g2, g1 + 1);
    assert.equal(bridgeStore.masterCredentials.findActive('b'.repeat(64)), null, 'the earlier generation is revoked');
    assert.equal(bridgeStore.masterCredentials.activate(g1, 'b'.repeat(64)), false, 'a revoked generation cannot be activated');
    assert.equal(bridgeStore.masterCredentials.activate(g2, 'c'.repeat(64)), true);
    assert.equal(bridgeStore.masterCredentials.revoke('handoff-failed', { generation: g2, credentialHash: 'e'.repeat(64) }), 0,
      'a late handoff naming another credential cannot revoke this one');

    assert.equal(bridgeStore.masterCredentials.revoke('master-killed'), 1);
    assert.equal(bridgeStore.masterCredentials.findActive('c'.repeat(64)), null);
    assert.equal(bridgeStore.masterCredentials.live(), null);
    // A generation is never reused, even after every one is revoked.
    assert.equal(bridgeStore.masterCredentials.mint('d'.repeat(64)), g2 + 1);
  });

  it('applies a route write once, however often its request id is replayed', () => {
    bridgeStore.routes.accept(inbound());
    const first = bridgeStore.applyRouteWrite(closeWrite());
    assert.deepEqual([first.outcome, first.replayed, first.route.state, first.route.version], ['applied', false, 'closed', 2]);

    const again = bridgeStore.applyRouteWrite(closeWrite({ change: () => { throw new Error('a replay must not decide again'); } }));
    assert.deepEqual([again.outcome, again.replayed, again.route.version], ['applied', true, 2]);
    assert.equal(bridgeStore.audit.forRoute('rt_1').length, 1);
  });

  it('refuses a write that names a stale version, and audits the refusal', () => {
    bridgeStore.routes.accept(inbound());
    bridgeStore.applyRouteWrite(closeWrite({ change: () => ({ set: { state: 'awaiting-master' } }) }));
    const stale = bridgeStore.applyRouteWrite(closeWrite({ requestId: 'req-00000002' }));
    assert.equal(stale.outcome, 'version-conflict');
    assert.equal(stale.route.state, 'awaiting-master');
    const rows = bridgeStore.audit.forRoute('rt_1');
    assert.deepEqual(rows.map((r) => r.outcome), ['applied', 'version-conflict']);
    assert.deepEqual(rows[1].detail, { currentVersion: 2 });
    assert.equal(rows[1].masterGeneration, 1);
  });

  it('audits a write to a route that does not exist and a refused decision', () => {
    const missing = bridgeStore.applyRouteWrite(closeWrite({ routeId: 'rt_none' }));
    assert.equal(missing.outcome, 'route-not-found');
    assert.equal(bridgeStore.audit.findRequest('close', 'req-00000001').outcome, 'route-not-found');

    bridgeStore.routes.accept(inbound());
    const refused = bridgeStore.applyRouteWrite(closeWrite({ requestId: 'req-00000003', change: () => ({ refuse: 'already-closed' }) }));
    assert.equal(refused.outcome, 'already-closed');
    assert.equal(refused.route.version, 1, 'a refusal changes nothing');
  });

  it('does not let one request id answer for a different route', () => {
    bridgeStore.routes.accept(inbound());
    bridgeStore.routes.accept(inbound({ routeId: 'rt_2', externalId: 'ext-2' }));
    bridgeStore.applyRouteWrite(closeWrite());
    const reused = bridgeStore.applyRouteWrite(closeWrite({ routeId: 'rt_2' }));
    assert.equal(reused.outcome, 'request-id-reused');
    assert.equal(reused.route.state, 'accepted');
  });

  it('clears a body and keeps the route, its digest and when it was cleared', () => {
    bridgeStore.routes.accept(inbound());
    assert.equal(bridgeStore.routes.clearBodies('rt_1', { at: '2026-10-04T01:00:00.000Z' }), 1);
    assert.deepEqual(bridgeStore.routes.bodies('rt_1'), [
      { role: 'inbound', text: null, digest, clearedAt: '2026-10-04T01:00:00.000Z' }
    ]);
    assert.equal(bridgeStore.routes.get('rt_1').externalId, 'ext-1');
    assert.equal(bridgeStore.routes.clearBodies('rt_1'), 0);
  });

  it('compacts old audit rows into a chained digest, and never a row of a route still open', () => {
    const old = '2026-01-01T00:00:00.000Z';
    bridgeStore.routes.accept(inbound({ at: old }));
    bridgeStore.routes.accept(inbound({ routeId: 'rt_2', externalId: 'ext-2', at: old }));
    bridgeStore.applyRouteWrite(closeWrite({ at: old }));
    bridgeStore.applyRouteWrite(closeWrite({ routeId: 'rt_2', requestId: 'req-00000002', at: old, change: () => ({ set: { state: 'awaiting-master' } }) }));
    bridgeStore.applyRouteWrite(closeWrite({ requestId: 'req-00000003', expectedVersion: 2, at: old, change: () => ({ refuse: 'already-closed' }) }));

    // rt_2 is open, so its row and everything after it stays.
    const first = bridgeStore.audit.compact({ before: '2026-06-01T00:00:00.000Z' });
    assert.equal(first.removed, 1);
    assert.equal(bridgeStore.audit.forRoute('rt_1').length, 1);
    assert.equal(bridgeStore.audit.forRoute('rt_2').length, 1);

    bridgeStore.applyRouteWrite(closeWrite({ routeId: 'rt_2', requestId: 'req-00000004', expectedVersion: 2, at: old }));
    const second = bridgeStore.audit.compact({ before: '2026-06-01T00:00:00.000Z' });
    assert.equal(second.removed, 3);
    const anchor = bridgeStore.audit.anchor();
    assert.deepEqual([anchor.removedCount, anchor.compactions, anchor.chainDigest], [4, 2, second.digest]);
    assert.notEqual(second.digest, first.digest, 'each compaction chains onto the one before');
    assert.deepEqual(bridgeStore.audit.compact({ before: '2026-06-01T00:00:00.000Z' }), { removed: 0, throughSeq: null, digest: null });
    assert.equal(bridgeStore.audit.anchor().compactions, 2, 'a compaction that removes nothing does not move the anchor');
  });

  it('keeps the audit and its anchor bounded across repeated retention cycles', () => {
    const db = store.getDb();
    const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    let day = Date.parse('2026-01-01T00:00:00.000Z');
    const sizes = [];
    for (let cycle = 0; cycle < 6; cycle++) {
      for (let i = 0; i < 5; i++) {
        const id = `rt_${cycle}_${i}`;
        const at = new Date(day).toISOString();
        bridgeStore.routes.accept(inbound({ routeId: id, externalId: `ext-${cycle}-${i}`, at }));
        bridgeStore.applyRouteWrite(closeWrite({ routeId: id, requestId: `req-cycle-${cycle}-${i}`, at,
          change: () => ({ set: { state: 'closed', closed_by: 'master', closed_at: at } }) }));
      }
      day += 120 * 24 * 60 * 60 * 1000;
      bridgeStore.prune({ now: new Date(day).toISOString() });
      sizes.push([count('bridge_audit'), count('bridge_routes'), count('bridge_route_bodies'), count('bridge_audit_anchor')]);
    }
    for (const size of sizes) assert.deepEqual(size, [0, 0, 0, 1]);
    assert.deepEqual([bridgeStore.audit.anchor().removedCount, bridgeStore.audit.anchor().compactions], [30, 6]);
  });

  it('prunes what has outlived its retention and nothing still in progress', () => {
    const old = '2026-01-01T00:00:00.000Z';
    const now = '2026-10-04T00:00:00.000Z';
    bridgeStore.routes.accept(inbound({ at: old }));
    bridgeStore.routes.accept(inbound({ routeId: 'rt_open', externalId: 'ext-open', at: old }));
    bridgeStore.routes.accept(inbound({ routeId: 'rt_recent', externalId: 'ext-recent', at: now }));
    bridgeStore.applyRouteWrite(closeWrite({ at: old,
      change: () => ({ set: { state: 'closed', closed_by: 'master', closed_at: old } }) }));
    bridgeStore.applyRouteWrite(closeWrite({ routeId: 'rt_recent', requestId: 'req-00000009', at: now,
      change: () => ({ set: { state: 'closed', closed_by: 'master', closed_at: now } }) }));
    const db = store.getDb();
    db.prepare('INSERT INTO bridge_nonces (nonce, seen_at) VALUES (?, ?), (?, ?)').run('n'.repeat(16), old, 'm'.repeat(16), now);
    bridgeStore.helperTokens.replace('t-old', 'e'.repeat(64), { at: old });
    bridgeStore.helperTokens.replace('t-new', 'f'.repeat(64), { at: old });
    bridgeStore.pins.setGlobal({ pinId: 'p-old', conversationKey: null, destination: { kind: 'master' }, at: old });
    bridgeStore.pins.setGlobal({ pinId: 'p-new', conversationKey: null, destination: { kind: 'master' }, at: old });
    const g1 = bridgeStore.masterCredentials.mint('b'.repeat(64), { at: old });
    bridgeStore.masterCredentials.revoke('master-killed', { at: old });
    const g2 = bridgeStore.masterCredentials.mint('c'.repeat(64), { at: old });
    bridgeStore.masterCredentials.revoke('master-killed', { at: old });

    const removed = bridgeStore.prune({ now });
    assert.deepEqual(removed, { nonces: 1, leases: 0, claims: 0, routes: 1, outbound: 0, candidates: 0, pins: 1, helperTokens: 1, credentials: 1, audit: 1 });
    assert.equal(bridgeStore.helperTokens.active().tokenId, 't-new', 'the active token stays');
    assert.deepEqual(bridgeStore.pins.list().map((p) => p.pinId), ['p-new'], 'and so does the active pin');
    assert.equal(bridgeStore.routes.get('rt_1'), null);
    assert.deepEqual(bridgeStore.routes.bodies('rt_1'), [], 'a removed route takes its bodies with it');
    assert.ok(bridgeStore.routes.get('rt_open'), 'an open route stays whatever its age');
    assert.ok(bridgeStore.routes.get('rt_recent'));
    assert.equal(bridgeStore.masterCredentials.mint('d'.repeat(64)), g2 + 1, 'generations are still never reused');
    assert.ok(g1 < g2);
  });

  it('gives a route one status notice, with fixed text chosen by name', () => {
    bridgeStore.routes.accept(inbound());
    const first = bridgeStore.outbound.enqueueStatus('rt_1', 'master-unavailable');
    const second = bridgeStore.outbound.enqueueStatus('rt_1', 'pending');
    assert.deepEqual([first.created, second.created], [true, false]);
    assert.equal(second.item.text, bridgeStore.STATUS_TEXT['master-unavailable'], 'the first notice stands');
    assert.equal(first.item.kind, 'status');
    assert.throws(() => bridgeStore.outbound.enqueueStatus('rt_1', 'anything else'), /unknown status notice/);
    assert.throws(() => bridgeStore.outbound.enqueue({
      idemKey: 'k', kind: 'status', routeId: 'rt_1', sourceLabel: 'x', text: 'my own words', digest
    }), /fixed text/);
  });

  it('lists open routes oldest first and leaves closed ones out', () => {
    bridgeStore.routes.accept(inbound({ at: '2026-10-04T00:00:02.000Z' }));
    bridgeStore.routes.accept(inbound({ routeId: 'rt_2', externalId: 'ext-2', at: '2026-10-04T00:00:01.000Z' }));
    bridgeStore.applyRouteWrite(closeWrite());
    assert.deepEqual(bridgeStore.routes.list().map((r) => r.routeId), ['rt_2']);
    assert.deepEqual(bridgeStore.routes.list({ states: ['closed'] }).map((r) => r.routeId), ['rt_1']);
    assert.deepEqual(bridgeStore.routes.list({ states: ['not-a-state'] }), []);
  });
});
