'use strict';

// #2031 (ADR 0023 Decisions 21 and 23): what the helper may write about an
// item, and what becomes of an item it cannot post. Every such write is bound
// to the lease and the token first, and a caller that is not bound learns
// nothing of the item. Each posted message is recorded the moment it is
// reported, and a later claim says which are already posted. An
// acknowledgement seals only a whole set. A failure is reported with a reason
// from a closed list: one a retry may fix leaves the item waiting, one it will
// not sets the item aside and tells the operator, and only the Project Master
// or the operator can put it back or withdraw it. The helper discards nothing.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel, setConsoleStream } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const bridgeStore = require('../lib/bridge-store');
const gateway = require('../lib/bridge-gateway');
const { FAILURE_REASONS } = require('../lib/bridge-schema');

const DAY = 24 * 60 * 60 * 1000;
const T0 = '2026-10-04T00:00:00.000Z';
const LEASE = bridgeStore.LEASE_MS;

let tmpDir;
let realNow;
let helper;
let seq;

/**
 * The instant a given number of milliseconds after T0.
 * @param {number} ms - Offset.
 * @returns {string}
 */
function at(ms) {
  return new Date(Date.parse(T0) + ms).toISOString();
}

/**
 * Set the gateway's clock.
 * @param {number} ms - Offset from T0.
 * @returns {void}
 */
function clockAt(ms) {
  gateway._deps.now = () => at(ms);
}

/**
 * Queue a notification at T0.
 * @param {string} name - Distinguishes it from the others.
 * @returns {number} Its id.
 */
function waiting(name) {
  const text = `notice ${name}`;
  return bridgeStore.outbound.enqueue({
    idemKey: `notify:operator-needed:${name}`, kind: 'notification', notifyType: 'operator-needed', sourceLabel: 'TangleClaw',
    text, digest: bridgeStore.digest(text), at: T0
  }).outboundId;
}

/**
 * Claim as the helper.
 * @param {object} [options] - `nonce`, `as` (another token).
 * @returns {object[]} The claimed items.
 */
function claim(options = {}) {
  return gateway.claimOutbound(options.as || helper, options.nonce || `decisions-nonce-${String(++seq).padStart(6, '0')}`, { limit: 20 }).body.items;
}

/**
 * Report one posted part.
 * @param {object} item - A claimed item.
 * @param {number} partIndex - Which part.
 * @param {number} partCount - Of how many.
 * @param {string} externalId - The chat's id for it.
 * @param {object} [as] - Another token.
 * @returns {{status: number, body: object}}
 */
function part(item, partIndex, partCount, externalId, as = helper) {
  return gateway.recordPart(item.outboundId, { leaseId: item.leaseId, tokenId: as.tokenId, partIndex, partCount, externalId });
}

/**
 * Seal an item.
 * @param {object} item - A claimed item.
 * @param {string[]} parts - Every part's id, in order.
 * @param {object} [as] - Another token.
 * @returns {{status: number, body: object}}
 */
function seal(item, parts, as = helper) {
  return gateway.acknowledgeOutbound(item.outboundId, undefined, { leaseId: item.leaseId, tokenId: as.tokenId, parts, partCount: parts.length });
}

/**
 * Report a failure.
 * @param {object} item - A claimed item.
 * @param {string} reason - Why.
 * @param {object} [over] - `parts`, `partCount`, `as`.
 * @returns {{status: number, body: object}}
 */
function fail(item, reason, over = {}) {
  return gateway.reportFailure(item.outboundId, {
    leaseId: item.leaseId, tokenId: (over.as || helper).tokenId, reason, parts: over.parts, partCount: over.partCount
  });
}

/**
 * Decide about an item, as the Project Master.
 * @param {('outbound-requeue'|'outbound-withdraw')} op - The decision.
 * @param {number} outboundId - The item.
 * @param {object} [over] - `requestId`, `actor`.
 * @returns {object}
 */
function decide(op, outboundId, over = {}) {
  return bridgeStore.applyOutboundWrite({
    op, outboundId, requestId: over.requestId || `req-decide-${++seq}-0000`, actor: over.actor || 'master',
    proof: over.actor === 'operator' ? 'verified-session' : 'master-launch', masterGeneration: over.actor === 'operator' ? null : 1,
    at: gateway._deps.now()
  });
}

/**
 * An item's state and why it is set aside.
 * @param {number} id - Item id.
 * @returns {Array}
 */
/**
 * Run `fn` and return the warnings it logged, one line each.
 * @param {function(): void} fn - What to run.
 * @returns {string[]}
 */
function warnings(fn) {
  const lines = [];
  setLevel('warn');
  setConsoleStream({ write: (line) => { lines.push(String(line).trimEnd()); } });
  try {
    fn();
  } finally {
    setConsoleStream(null);
    setLevel('error');
  }
  return lines;
}

/**
 * @param {number} id - Outbound id.
 * @returns {*} How the item stands.
 */
function standing(id) {
  const item = bridgeStore.outbound.get(id);
  return [item.state, item.blockCode];
}

describe('bridge: what the helper may write about an item, and what becomes of one it cannot post (#2031)', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-bridge-decisions-'));
    store._setBasePath(tmpDir);
    store.init();
    realNow = gateway._deps.now;
    gateway._reset();
    seq = 0;
    clockAt(0);
    helper = { tokenId: gateway.mintHelperToken().tokenId };
  });

  afterEach(() => {
    gateway._deps.now = realNow;
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('bound before anything is said', () => {
    it('every write about an item answers a caller that does not hold its lease the same way, whatever became of the item', () => {
      const ids = ['waiting', 'delivered', 'blocked', 'dropped'].map((name) => waiting(name));
      const items = claim();
      const other = { tokenId: 'bht_another' };
      assert.equal(seal(items[1], ['d100']).status, 200);
      assert.equal(fail(items[2], 'rejected-by-chat').body.state, 'blocked');
      clockAt(8 * DAY);
      bridgeStore.expire({ now: at(8 * DAY) });
      assert.deepEqual(ids.map((id) => standing(id)[0]), ['dropped', 'delivered', 'dropped', 'dropped']);

      const writes = (item, as, leaseId = item.leaseId) => [
        seal({ ...item, leaseId }, ['d900'], as), part({ ...item, leaseId }, 0, 1, 'd900', as), fail({ ...item, leaseId }, 'transient', { as })
      ].map((r) => [r.status, r.body.code]);
      for (const item of items) {
        assert.deepEqual(writes(item, other), Array(3).fill([403, 'LEASE_NOT_YOURS']), `another token, item ${item.outboundId}`);
        assert.deepEqual(writes(item, helper, 'bol_nosuchlease00000000000'), Array(3).fill([404, 'LEASE_NOT_FOUND']), `no such lease, item ${item.outboundId}`);
        assert.deepEqual(writes(item, helper, items[(items.indexOf(item) + 1) % 4].leaseId), Array(3).fill([404, 'LEASE_NOT_FOUND']), 'another item\'s lease');
      }
      assert.deepEqual(writes({ outboundId: 9999, leaseId: items[0].leaseId }, helper), Array(3).fill([404, 'LEASE_NOT_FOUND']), 'an item that never was');
      for (const bad of [null, 'short', 12]) {
        assert.deepEqual(writes(items[0], helper, bad), Array(3).fill([400, 'LEASE_REQUIRED']));
      }
    });

    it('a lease that is no longer live is told only that, whatever became of its item', () => {
      const names = ['still waiting', 'delivered by another', 'set aside', 'withdrawn', 'let go'];
      const ids = names.map((name) => waiting(name));
      const old = claim();
      // One is set aside while its lease is live; the rest of the leases lapse by time.
      assert.equal(fail(old[2], 'rejected-by-chat').body.state, 'blocked');
      clockAt(LEASE + 1);
      const fresh = claim();
      assert.equal(seal(fresh.find((i) => i.outboundId === ids[1]), ['d100']).status, 200);
      clockAt(2 * (LEASE + 1));
      assert.equal(decide('outbound-withdraw', ids[3]).outcome, 'applied');
      clockAt(8 * DAY);
      bridgeStore.expire({ now: at(8 * DAY) });
      claim();
      assert.deepEqual(ids.map((id) => bridgeStore.outbound.get(id).state), ['dropped', 'delivered', 'dropped', 'dropped', 'dropped']);

      // Every old lease of the helper's own, on every route, gets one answer.
      const answers = old.flatMap((item) => [seal(item, ['d900']), seal(item, ['d100']), part(item, 0, 1, 'd900'), fail(item, 'transient'), fail(item, 'rejected-by-chat')]);
      for (const answer of answers) assert.deepEqual([answer.status, answer.body], [409, answers[0].body]);
      assert.equal(answers[0].body.code, 'LEASE_LAPSED');
      assert.ok(!/deliver|withdraw|set aside|let go|expired|blocked/i.test(JSON.stringify(answers[0].body)), 'and the answer names no state');
    });

    it('the lease that sealed a delivery can always learn that it landed; no other lease can', () => {
      const id = waiting('a');
      const [first] = claim();
      clockAt(LEASE + 1);
      const [second] = claim();
      assert.equal(second.outboundId, id);
      assert.equal(part(second, 0, 2, 'd100').status, 200);
      assert.equal(seal(second, ['d100', 'd101']).body.replayed, false);
      // The earlier lease is this token's and this item's, and still on record. It did not seal the item, so it learns nothing.
      assert.deepEqual([seal(first, ['d100', 'd101']).status, seal(first, ['d100', 'd101']).body.code], [409, 'LEASE_LAPSED']);

      clockAt(20 * DAY);
      bridgeStore.prune({ now: at(20 * DAY) });
      const again = seal(second, ['d100', 'd101']);
      assert.deepEqual([again.status, again.body], [200, { outboundId: id, state: 'delivered', replayed: true, parts: 2 }], 'twenty days on, the receipt still answers');
      assert.equal(seal(second, ['d100']).body.code, 'ACK_MISMATCH', 'and only for exactly what it sealed');
      // The receipt answers through the acknowledgement alone: the same lease learns nothing on the other routes.
      assert.equal(part(second, 0, 2, 'd100').body.code, 'LEASE_LAPSED');
      assert.equal(fail(second, 'transient').body.code, 'LEASE_LAPSED');
      assert.equal(seal(first, ['d100', 'd101']).body.code, 'LEASE_NOT_FOUND', 'the lapsed lease is forgotten, and says nothing');
      // Nor does the receipt outlive its token's authority.
      assert.equal(seal(second, ['d100', 'd101'], { tokenId: 'bht_another' }).body.code, 'LEASE_NOT_YOURS');
    });
  });

  describe('what counts as delivered', () => {
    const db = () => store.getDb();
    const ack = (item) => ({ leaseId: item.leaseId, tokenId: helper.tokenId, at: gateway._deps.now() });
    const leaseState = (item) => db().prepare('SELECT state FROM bridge_outbound_leases WHERE lease_id = ?').get(item.leaseId).state;
    const row = (id) => db().prepare('SELECT state, delivered_ref, delivered_at, drop_code, block_code, text FROM bridge_outbound WHERE outbound_id = ?').get(id);
    const deliveredAudits = () => db().prepare("SELECT COUNT(*) AS n FROM bridge_audit WHERE op IN ('delivered', 'helper-ack')").get().n;

    it('an item that is not there to be delivered is never reported delivered, and nothing is recorded as if it were', () => {
      // Each of these still has a live lease, so the acknowledgement itself is in order: only the item is wrong.
      const CASES = [
        ['withdrawn', "UPDATE bridge_outbound SET state = 'dropped', drop_code = 'withdrawn', text = NULL WHERE outbound_id = ?"],
        ['set aside', "UPDATE bridge_outbound SET state = 'blocked', block_code = 'rejected-by-chat' WHERE outbound_id = ?"],
        ['delivered already, under another message', "UPDATE bridge_outbound SET state = 'delivered', delivered_ref = 'd999', delivered_at = '2026-01-01T00:00:00.000Z', text = NULL WHERE outbound_id = ?"]
      ];
      let n = 0;
      for (const [why, sql] of CASES) {
        n += 1;
        const id = waiting(`gone-${n}`);
        const [item] = claim();
        db().prepare(sql).run(id);
        const before = JSON.stringify(row(id));
        const audits = deliveredAudits();
        assert.equal(bridgeStore.outbound.ackVerdict(id, [`d${n}00`], ack(item)), 'deliverable', `${why}: precondition, the lease and the message ids are in order`);

        const marked = bridgeStore.transaction(() => bridgeStore.outbound.markDelivered(id, [`d${n}00`], ack(item)));
        assert.equal(marked.outcome, 'item-not-ready', why);
        assert.equal(JSON.stringify(row(id)), before, `${why}: the item is as it was`);
        assert.deepEqual(bridgeStore.parts.forItem(id), [], `${why}: no posted message was recorded for it`);
        assert.equal(leaseState(item), 'live', `${why}: the lease was not settled as used`);

        let answered;
        const logged = warnings(() => { answered = seal(item, [`d${n}00`]); });
        assert.deepEqual([answered.status, answered.body.code], [409, 'ACK_NOT_APPLIED'], `${why}: and the helper is not told it was delivered`);
        assert.equal(logged.length, 1, `${why}: the refusal is on the record, once`);
        assert.ok(logged[0].endsWith(`Bridge acknowledgement was not applied outboundId=${id} outcome=item-not-ready`), logged[0]);
        assert.ok(!JSON.stringify(answered.body).includes('"state":"delivered"'));
        assert.equal(JSON.stringify(row(id)), before);
        assert.equal(deliveredAudits(), audits, `${why}: nothing audited as a delivery`);
      }
    });

    it('no row moving is a delivery only when the item is already exactly that delivery', () => {
      const mark = (id, item, ids) => bridgeStore.transaction(() => bridgeStore.outbound.markDelivered(id, ids, ack(item)));
      const setDelivered = (id, ref) => db().prepare("UPDATE bridge_outbound SET state = 'delivered', delivered_ref = ?, delivered_at = '2026-01-01T00:00:00.000Z', text = NULL WHERE outbound_id = ?").run(ref, id);

      // Both messages on record, the item already delivered under the first of them, and the lease still open:
      // the one state in which no row moves and the answer is still "delivered".
      const id = waiting('twice');
      const [item] = claim();
      assert.equal(part(item, 0, 2, 'd500').status, 200);
      assert.equal(part(item, 1, 2, 'd501').status, 200);
      setDelivered(id, 'd500');
      const sealed = JSON.stringify(row(id));
      assert.equal(mark(id, item, ['d500', 'd501']).outcome, 'delivered', 'the identical delivery, again');
      assert.equal(JSON.stringify(row(id)), sealed, 'and nothing about the item moved, its delivery time included');
      assert.equal(leaseState(item), 'live', 'nor was anything else written');
      // The same state and the same messages, but delivered under another first message: not this delivery.
      setDelivered(id, 'd777');
      assert.equal(mark(id, item, ['d500', 'd501']).outcome, 'item-not-ready');
      // Clearly delivered, with the right reference, but the list on record is not the list named.
      const short = waiting('short');
      const [shortItem] = claim();
      assert.equal(part(shortItem, 0, 2, 'd600').status, 200);
      setDelivered(short, 'd600');
      assert.equal(bridgeStore.outbound.ackVerdict(short, ['d600', 'd601'], ack(shortItem)), 'deliverable', 'precondition: nothing about the acknowledgement itself is wrong');
      assert.equal(mark(short, shortItem, ['d600', 'd601']).outcome, 'item-not-ready', 'one message is on record, two are named');
      assert.deepEqual(bridgeStore.parts.forItem(short), ['d600'], 'and the other was not quietly added to a delivery already sealed');
      assert.deepEqual([seal(shortItem, ['d600', 'd601']).status, seal(shortItem, ['d600', 'd601']).body.code], [409, 'ACK_NOT_APPLIED']);
      // An item that does not exist at all.
      assert.notEqual(mark(987654, item, ['d900']).outcome, 'delivered');
    });

    it('the ordinary delivery still moves exactly one row, records its messages and settles its lease', () => {
      const id = waiting('once');
      const [item] = claim();
      const marked = bridgeStore.transaction(() => bridgeStore.outbound.markDelivered(id, ['d800', 'd801'], ack(item)));
      assert.deepEqual([marked.outcome, marked.item.state], ['delivered', 'delivered']);
      assert.deepEqual([row(id).delivered_ref, row(id).text, bridgeStore.parts.forItem(id), leaseState(item)], ['d800', null, ['d800', 'd801'], 'used']);
    });
  });

  describe('the lease window', () => {
    it('is judged by the lease\'s own expiry, whether or not anything has yet marked the lease lapsed', () => {
      const id = waiting('a');
      const [item] = claim();
      const ack = (ms) => ({ leaseId: item.leaseId, tokenId: helper.tokenId, at: at(ms) });
      const state = () => store.getDb().prepare('SELECT state FROM bridge_outbound_leases WHERE lease_id = ?').get(item.leaseId).state;

      assert.equal(bridgeStore.outbound.ackVerdict(id, ['d100'], ack(LEASE)), 'deliverable', 'at exactly the end of the window');
      // One millisecond later nothing has swept the lease yet: it still reads live, and is refused all the same.
      assert.equal(state(), 'live');
      assert.equal(bridgeStore.outbound.ackVerdict(id, ['d100'], ack(LEASE + 1)), 'lease-lapsed');
      assert.equal(bridgeStore.parts.receipt(id, { index: 0, count: 1, externalId: 'd100' }, ack(LEASE + 1)), 'lease-lapsed');
      assert.equal(bridgeStore.outbound.markDelivered(id, ['d100'], ack(LEASE + 1)).outcome, 'lease-lapsed');
      assert.deepEqual([state(), bridgeStore.outbound.get(id).state, bridgeStore.parts.forItem(id)], ['live', 'ready', []]);
    });
  });

  describe('recording a posted part at once', () => {
    it('records parts in order, tells a later claim which are posted, and seals only the whole set', () => {
      const id = waiting('a');
      const [item] = claim();
      assert.deepEqual([item.postedParts, item.partCount, item.attempts], [[], null, 1]);
      assert.deepEqual(part(item, 0, 3, 'd100').body, { outboundId: id, partIndex: 0, partCount: 3, replayed: false });
      assert.equal(part(item, 0, 3, 'd100').body.replayed, true, 'the same part again changes nothing');
      assert.equal(part(item, 1, 3, 'd101').status, 200);
      assert.deepEqual(bridgeStore.parts.find('d101').partIndex, 1, 'a reply to it resolves from this moment');
      assert.equal(standing(id)[0], 'ready', 'two of three is not delivered');

      const refusals = [
        [part(item, 0, 3, 'd199'), 409, 'PART_MISMATCH'], [part(item, 2, 4, 'd102'), 409, 'PART_MISMATCH'],
        [part(item, 2, 3, 'd100'), 409, 'PART_ID_COLLISION'],
        [seal(item, ['d100', 'd101']), 409, 'PART_MISMATCH'], [seal(item, ['d100', 'd199', 'd102']), 409, 'PART_MISMATCH'],
        [seal(item, ['d100']), 409, 'PART_MISMATCH'], [seal(item, ['d100', 'd101', 'd102', 'd103']), 409, 'PART_MISMATCH']
      ];
      for (const [result, status, code] of refusals) assert.deepEqual([result.status, result.body.code], [status, code]);
      assert.deepEqual([standing(id)[0], bridgeStore.parts.forItem(id)], ['ready', ['d100', 'd101']], 'none of them changed anything');

      // The lease lapses with the last part unposted. Whoever claims next is told where to carry on.
      clockAt(LEASE + 1);
      assert.equal(part(item, 2, 3, 'd102').body.code, 'LEASE_LAPSED');
      const [again] = claim();
      assert.deepEqual([again.outboundId, again.postedParts, again.partCount, again.attempts], [id, ['d100', 'd101'], 3, 2]);
      assert.equal(part(again, 2, 3, 'd102').status, 200);
      assert.equal(seal(again, ['d100', 'd101', 'd102']).body.replayed, false);
      assert.deepEqual([standing(id)[0], bridgeStore.outbound.get(id).deliveredRef], ['delivered', 'd100']);
      assert.equal(part(again, 2, 3, 'd102').body.code, 'LEASE_LAPSED', 'a sealed item takes no more parts: its lease is spent');
    });

    it('a part out of order, or one that is not a part, is refused and records nothing', () => {
      const id = waiting('a');
      const [item] = claim();
      assert.deepEqual([part(item, 1, 3, 'd101').status, part(item, 1, 3, 'd101').body.code], [409, 'PART_OUT_OF_ORDER']);
      for (const [index, count, externalId] of [[-1, 3, 'd1'], [3, 3, 'd1'], [0, 0, 'd1'], [0, bridgeStore.MAX_PARTS + 1, 'd1'], [0.5, 3, 'd1'], [0, 3, 'bad id!'], [0, 3, undefined], ['0', 3, 'd1']]) {
        assert.equal(part(item, index, count, externalId).body.code, 'BAD_PART', JSON.stringify([index, count, externalId]));
      }
      assert.deepEqual(bridgeStore.parts.forItem(id), []);
    });

    it('counts a hand-over once for each lease issued, and never for a claim repeated under its nonce', () => {
      const id = waiting('a');
      const attempts = () => bridgeStore.outbound.get(id).attempts;
      const leases = () => store.getDb().prepare('SELECT COUNT(*) AS n FROM bridge_outbound_leases WHERE outbound_id = ?').get(id).n;
      assert.equal(attempts(), 0);
      claim({ nonce: 'decisions-nonce-repeat1' });
      for (let i = 0; i < 3; i++) assert.equal(claim({ nonce: 'decisions-nonce-repeat1' })[0].attempts, 1, 'a repeat hands nothing over');
      assert.deepEqual([attempts(), leases()], [1, 1]);
      claim();
      assert.equal(attempts(), 1, 'a claim that finds it held hands nothing over either');
      for (let round = 2; round <= 4; round++) {
        clockAt(round * (LEASE + 1));
        assert.equal(claim()[0].attempts, round);
        assert.deepEqual([attempts(), leases()], [round, round], 'the count is the number of leases ever issued for the item');
      }
    });
  });

  describe('reporting a failure', () => {
    it('takes a reason from its closed list and no other', () => {
      waiting('a');
      const [item] = claim();
      assert.deepEqual(FAILURE_REASONS, {
        retryable: ['transient', 'outcome-unknown'],
        blocking: ['rejected-by-chat', 'outcome-unverifiable', 'part-conflict'],
        circuit: ['chat-channel-missing', 'chat-guild-missing', 'chat-permission-denied', 'chat-auth-refused']
      });
      for (const reason of ['discard', 'delete', '', undefined, 'Discord said: no', 'TRANSIENT', 'chat-configuration']) {
        const refused = fail(item, reason);
        assert.deepEqual([refused.status, refused.body.code], [400, 'BAD_FAILURE'], String(reason));
      }
      for (const over of [{ parts: ['d1', 'd1'], partCount: 2 }, { parts: ['d1'] }, { parts: ['d1', 'd2'], partCount: 1 }, { parts: 'd1', partCount: 1 }, { parts: ['bad id!'], partCount: 1 }]) {
        assert.equal(fail(item, 'transient', over).body.code, 'BAD_FAILURE', JSON.stringify(over));
      }
      assert.equal(store.getDb().prepare("SELECT COUNT(*) AS n FROM bridge_audit WHERE op = 'helper-failure'").get().n, 0);
    });

    it('a failure a retry may fix leaves the item waiting under its lease, on the record', () => {
      const id = waiting('a');
      const [item] = claim();
      for (const reason of FAILURE_REASONS.retryable) {
        assert.deepEqual(fail(item, reason).body, { outboundId: id, state: 'ready', reason });
      }
      assert.deepEqual(standing(id), ['ready', null]);
      assert.equal(store.getDb().prepare('SELECT state FROM bridge_outbound_leases WHERE lease_id = ?').get(item.leaseId).state, 'live');
      assert.equal(bridgeStore.outbound.ready().length, 1, 'and nothing is raised with the operator');
      assert.equal(seal(item, ['d100']).status, 200, 'the helper can still post it');
      const audit = store.getDb().prepare("SELECT actor, proof, outcome, detail_json FROM bridge_audit WHERE op = 'helper-failure' ORDER BY audit_seq").all();
      assert.deepEqual(audit.map((a) => [a.actor, a.proof, a.outcome, JSON.parse(a.detail_json).reason]),
        [['helper', 'helper-token', 'retryable', 'transient'], ['helper', 'helper-token', 'retryable', 'outcome-unknown']]);
    });

    it('a failure a retry will not fix sets the item aside, records the parts that posted, and tells the operator once', () => {
      for (const [index, reason] of FAILURE_REASONS.blocking.entries()) {
        const id = waiting(`item-${index}`);
        const [item] = claim();
        assert.deepEqual(fail(item, reason, { parts: ['a', 'b'].map((p) => `d${index}${p}`), partCount: 3 }).body, { outboundId: id, state: 'blocked', reason });
        assert.deepEqual(standing(id), ['blocked', reason]);
        assert.equal(bridgeStore.outbound.get(id).text, `notice item-${index}`, 'its text is kept: nothing is discarded');
        assert.deepEqual(bridgeStore.parts.forItem(id), [`d${index}a`, `d${index}b`]);
        assert.equal(store.getDb().prepare('SELECT state FROM bridge_outbound_leases WHERE lease_id = ?').get(item.leaseId).state, 'lapsed');

        // Reporting it again, or anything else about it, changes nothing.
        for (const again of [fail(item, reason), fail(item, 'transient'), seal(item, [`d${index}a`, `d${index}b`, `d${index}c`]), part(item, 2, 3, `d${index}c`)]) {
          assert.deepEqual([again.status, again.body.code], [409, 'LEASE_LAPSED']);
        }
        const notices = bridgeStore.outbound.ready();
        assert.deepEqual(notices.map((n) => [n.kind, n.notifyType, n.sourceLabel, n.text, n.idemKey]),
          [['notification', 'operator-needed', 'TangleClaw', gateway.BLOCKED_NOTICE, `outbound-blocked:${id}:1`]]);
        // The helper posts the notice, and the item it is about is not handed over with it.
        const [notice] = claim();
        assert.equal(notice.outboundId, notices[0].outboundId);
        assert.equal(seal(notice, [`n${index}`]).status, 200);
        clockAt((index + 1) * (LEASE + 1));
        assert.deepEqual(claim(), [], 'an item set aside is handed to nobody');
      }
    });

    it('the notice that something was set aside is never itself set aside', () => {
      const id = waiting('a');
      fail(claim()[0], 'rejected-by-chat');
      const [notice] = claim();
      assert.deepEqual(fail(notice, 'rejected-by-chat').body, { outboundId: notice.outboundId, state: 'ready', reason: 'rejected-by-chat' });
      assert.deepEqual([standing(notice.outboundId), standing(id)], [['ready', null], ['blocked', 'rejected-by-chat']]);
      assert.equal(bridgeStore.outbound.ready().length, 1, 'and no notice is raised about the notice');
      assert.equal(seal(notice, ['d100']).status, 200, 'it is posted as soon as the helper can');
    });

    it('a refused part undoes the whole report', () => {
      const [a, b] = [waiting('a'), waiting('b')];
      const [first, second] = claim();
      assert.equal(part(first, 0, 1, 'd100').status, 200);
      const refused = fail(second, 'rejected-by-chat', { parts: ['d200', 'd100'], partCount: 3 });
      assert.deepEqual([refused.status, refused.body.code], [409, 'PART_ID_COLLISION']);
      assert.deepEqual([standing(b), bridgeStore.parts.forItem(b)], [['ready', null], []], 'nothing of it was recorded, and the item is not set aside');
      assert.equal(standing(a)[0], 'ready');
    });
  });

  describe('when the chat itself is not taking posts', () => {
    /**
     * Every row of every table a claim could touch, for comparing before and after.
     * @returns {object}
     */
    function everything() {
      const db = store.getDb();
      const dump = (table, order) => db.prepare(`SELECT * FROM ${table} ORDER BY ${order}`).all();
      return {
        outbound: dump('bridge_outbound', 'outbound_id'), leases: dump('bridge_outbound_leases', 'lease_id'), claims: dump('bridge_outbound_claims', 'claim_nonce'),
        nonces: dump('bridge_nonces', 'nonce'), parts: dump('bridge_outbound_parts', 'part_external_id'), audit: dump('bridge_audit', 'audit_seq'),
        circuit: dump('bridge_config_circuit', 'episode_id'), routes: dump('bridge_routes', 'route_id')
      };
    }

    /**
     * A claim's whole answer.
     * @param {string} [nonce] - The claim's nonce.
     * @returns {{status: number, body: object}}
     */
    function poll(nonce) {
      return gateway.claimOutbound(helper, nonce || `decisions-nonce-${String(++seq).padStart(6, '0')}`, { limit: 20 });
    }

    /**
     * Reset the circuit.
     * @param {('requeue'|'withdraw')} decision - What becomes of the items set aside.
     * @param {object} [over] - `requestId`, `actor`.
     * @returns {object}
     */
    function reset(decision, over = {}) {
      return bridgeStore.applyCircuitReset({
        decision, requestId: over.requestId || `req-reset-${++seq}-0000`, actor: over.actor || 'master',
        proof: over.actor === 'operator' ? 'verified-session' : 'master-launch', masterGeneration: over.actor === 'operator' ? null : 1,
        at: gateway._deps.now()
      });
    }

    it('one report sets the item aside, opens one episode, raises one notice, and stops every claim', () => {
      const [a, b, c] = [waiting('a'), waiting('b'), waiting('c')];
      const [first] = gateway.claimOutbound(helper, 'decisions-nonce-first1', { limit: 1 }).body.items;
      clockAt(1000);
      const report = fail(first, 'chat-permission-denied', { parts: ['d100'], partCount: 2 });
      assert.deepEqual(report.body, { outboundId: a, state: 'blocked', reason: 'chat-permission-denied', circuit: { episodeId: 1, opened: true } });
      assert.deepEqual(standing(a), ['blocked', 'chat-permission-denied']);
      assert.deepEqual(bridgeStore.parts.forItem(a), ['d100'], 'the part that did post is recorded');
      assert.deepEqual(bridgeStore.circuit.open(), {
        episodeId: 1, reason: 'chat-permission-denied', outboundId: a, openedAt: at(1000), closedAt: null, closedBy: null, decision: null,
        masterToldAt: null, masterToldGeneration: null, masterAckedAt: null, masterAckedGeneration: null, surfaceKind: 'guild-channel'
      });
      const notices = bridgeStore.outbound.ready().filter((i) => i.idemKey.startsWith('config-circuit:'));
      assert.deepEqual(notices.map((n) => [n.idemKey, n.kind, n.notifyType, n.text]), [['config-circuit:1', 'notification', 'operator-needed', gateway.CIRCUIT_NOTICE]]);
      assert.equal(bridgeStore.outbound.ready().filter((i) => i.idemKey.startsWith('outbound-blocked:')).length, 0, 'the episode\'s notice is the only one');

      // Every poll from now on gets one typed answer, and changes nothing whatever.
      const before = everything();
      const answers = [poll(), poll(), poll('decisions-nonce-first1'), poll('decisions-nonce-first1')];
      for (const answer of answers) {
        assert.deepEqual([answer.status, answer.body.code, answer.body.episodeId, answer.body.reason, answer.body.since],
          [409, 'BRIDGE_CONFIGURATION_BLOCKED', 1, 'chat-permission-denied', at(1000)]);
        assert.equal(answer.body.items, undefined);
      }
      assert.deepEqual(everything(), before, 'no lease, no hand-over count, no nonce, no notice, no audit row: nothing');
      assert.deepEqual([standing(b), standing(c)], [['ready', null], ['ready', null]], 'what is queued stays queued, untouched');
      assert.deepEqual([bridgeStore.outbound.get(b).attempts, bridgeStore.outbound.get(c).attempts], [0, 0]);
    });

    it('two reports of the same broken chat open one episode and raise one notice', () => {
      const [a, b] = [waiting('a'), waiting('b')];
      const [first, second] = claim();
      const one = fail(first, 'chat-channel-missing');
      const two = fail(second, 'chat-permission-denied');
      assert.deepEqual([one.body.circuit, two.body.circuit], [{ episodeId: 1, opened: true }, { episodeId: 1, opened: false }]);
      assert.deepEqual([standing(a), standing(b)], [['blocked', 'chat-channel-missing'], ['blocked', 'chat-permission-denied']], 'each item in hand is set aside');
      assert.equal(store.getDb().prepare('SELECT COUNT(*) AS n FROM bridge_config_circuit').get().n, 1);
      assert.equal(bridgeStore.circuit.open().reason, 'chat-channel-missing', 'the episode is the first report\'s');
      assert.equal(store.getDb().prepare("SELECT COUNT(*) AS n FROM bridge_outbound WHERE kind = 'notification' AND idem_key NOT LIKE 'notify:%'").get().n, 1, 'one notice');
      // The store itself will not hold two open episodes, whoever tries.
      assert.throws(() => store.getDb().prepare("INSERT INTO bridge_config_circuit (reason, outbound_id, opened_at) VALUES ('chat-auth-refused', ?, ?)").run(b, T0), /UNIQUE/);
      assert.deepEqual(bridgeStore.circuit.trip('chat-auth-refused', b), { opened: false, episode: bridgeStore.circuit.open() });
    });

    it('a refusal of one item, or one a retry may fix, never opens it', () => {
      for (const reason of [...FAILURE_REASONS.retryable, ...FAILURE_REASONS.blocking]) {
        waiting(reason);
        const item = claim().at(-1);
        assert.equal(fail(item, reason).body.circuit, undefined, reason);
        assert.equal(bridgeStore.circuit.open(), null, reason);
        clockAt(Date.parse(gateway._deps.now()) - Date.parse(T0) + LEASE + 1);
      }
      assert.equal(poll().status, 200);
    });

    it('stays open across a restart and for any length of time', async () => {
      const a = waiting('a');
      fail(claim()[0], 'chat-auth-refused');
      store.close();
      store._setBasePath(tmpDir);
      store.init();
      assert.equal(bridgeStore.circuit.open().episodeId, 1, 'after a restart');
      assert.equal(poll().body.code, 'BRIDGE_CONFIGURATION_BLOCKED');

      clockAt(400 * DAY);
      await gateway.tick();
      bridgeStore.expire({ now: at(400 * DAY) });
      bridgeStore.prune({ now: at(400 * DAY) });
      assert.equal(bridgeStore.circuit.open().episodeId, 1, 'no passage of time closes it');
      assert.equal(poll().body.code, 'BRIDGE_CONFIGURATION_BLOCKED');
      assert.equal(standing(a)[0], 'dropped', 'the item it caught still has its own retention limit');
    });

    it('is reset by the Master or the operator, who say what becomes of the items it set aside', () => {
      const [a, b, c] = [waiting('a'), waiting('b'), waiting('c')];
      const items = gateway.claimOutbound(helper, 'decisions-nonce-reset1', { limit: 2 }).body.items;
      fail(items[0], 'chat-permission-denied', { parts: ['d100'], partCount: 2 });
      fail(items[1], 'chat-permission-denied');
      assert.equal(reset('requeue', { requestId: 'req-reset-0001' }).outcome, 'applied');
      clockAt(LEASE + 1);
      assert.equal(bridgeStore.circuit.open(), null);
      const closed = store.getDb().prepare('SELECT * FROM bridge_config_circuit WHERE episode_id = 1').get();
      assert.deepEqual([closed.closed_by, closed.decision, closed.closed_at !== null], ['master', 'requeue', true]);
      assert.deepEqual([standing(a), standing(b), standing(c)], [['ready', null], ['ready', null], ['ready', null]]);
      const notice = store.getDb().prepare("SELECT state, drop_code, text FROM bridge_outbound WHERE idem_key = 'config-circuit:1'").get();
      assert.deepEqual([notice.state, notice.drop_code, notice.text], ['dropped', 'withdrawn', null], 'the episode\'s notice is not posted after the fact');

      const again = reset('requeue', { requestId: 'req-reset-0001' });
      assert.deepEqual([again.outcome, again.replayed, again.items, again.episode.episodeId], ['applied', true, 2, 1]);
      assert.equal(reset('withdraw', { requestId: 'req-reset-0001' }).outcome, 'request-id-reused');
      assert.equal(reset('requeue').outcome, 'circuit-not-open');

      const handed = poll().body.items;
      assert.deepEqual(handed.map((i) => [i.outboundId, i.postedParts]), [[a, ['d100']], [b, []], [c, []]], 'claims resume, with what was already posted');

      // A second episode is a new one, with its own notice; the operator withdraws what it caught.
      const own = waiting('own');
      clockAt(2 * (LEASE + 1));
      const next = poll().body.items;
      fail(next.find((i) => i.outboundId === own), 'rejected-by-chat');
      const caught = fail(next.find((i) => i.outboundId === a), 'chat-channel-missing');
      assert.deepEqual(caught.body.circuit, { episodeId: 2, opened: true });
      const byOperator = reset('withdraw', { actor: 'operator' });
      assert.deepEqual([byOperator.outcome, byOperator.items, byOperator.episode.closedBy, byOperator.episode.decision], ['applied', 1, 'operator', 'withdraw']);
      assert.deepEqual([standing(a)[0], bridgeStore.outbound.get(a).dropCode, bridgeStore.outbound.get(a).text], ['dropped', 'withdrawn', null]);
      assert.deepEqual(standing(own), ['blocked', 'rejected-by-chat'], 'an item set aside for its own reason is not the reset\'s to decide');
      const audit = store.getDb().prepare("SELECT actor, outcome, detail_json FROM bridge_audit WHERE op = 'circuit-reset' AND outcome = 'applied' ORDER BY audit_seq").all();
      assert.deepEqual(audit.map((r) => [r.actor, JSON.parse(r.detail_json).episodeId, JSON.parse(r.detail_json).decision, JSON.parse(r.detail_json).items]),
        [['master', 1, 'requeue', 2], ['operator', 2, 'withdraw', 1]]);
    });

    it('an episode\'s record cannot be rewritten, and a closed one is final', () => {
      waiting('a');
      fail(claim()[0], 'chat-guild-missing');
      const db = store.getDb();
      assert.throws(() => db.exec("UPDATE bridge_config_circuit SET reason = 'chat-auth-refused'"), /fixed once opened/);
      assert.throws(() => db.exec("UPDATE bridge_config_circuit SET closed_at = 'x'"), /CHECK/, 'closing says who and what was decided');
      reset('withdraw');
      assert.throws(() => db.exec('UPDATE bridge_config_circuit SET closed_at = NULL, closed_by = NULL, decision = NULL'), /final once closed/);
    });
  });

  describe('deciding what becomes of an item set aside', () => {
    it('putting it back hands it over again, with the parts already posted', () => {
      const id = waiting('a');
      fail(claim()[0], 'rejected-by-chat', { parts: ['d100'], partCount: 2 });
      const back = decide('outbound-requeue', id, { requestId: 'req-requeue-0001' });
      assert.deepEqual([back.outcome, back.replayed, back.item.state, back.item.blockCode], ['applied', false, 'ready', null]);
      assert.deepEqual(decide('outbound-requeue', id, { requestId: 'req-requeue-0001' }).replayed, true, 'the same request again changes nothing');
      assert.equal(decide('outbound-requeue', id).outcome, 'not-blocked');

      const item = claim().find((i) => i.outboundId === id);
      assert.deepEqual([item.postedParts, item.partCount, item.attempts, item.text], [['d100'], 2, 2, 'notice a']);
      assert.equal(part(item, 1, 2, 'd101').status, 200);
      assert.equal(seal(item, ['d100', 'd101']).status, 200);
      // Set aside a second time, it raises a second notice: each is for one hand-over.
      const other = waiting('b');
      fail(claim().find((i) => i.outboundId === other), 'rejected-by-chat');
      decide('outbound-requeue', other);
      clockAt(LEASE + 1);
      fail(claim().find((i) => i.outboundId === other), 'rejected-by-chat');
      const keys = store.getDb().prepare("SELECT idem_key FROM bridge_outbound WHERE idem_key LIKE 'outbound-blocked:%' ORDER BY outbound_id").all().map((r) => r.idem_key);
      assert.deepEqual(keys, [`outbound-blocked:${id}:1`, `outbound-blocked:${other}:1`, `outbound-blocked:${other}:2`]);
    });

    it('withdrawing it is final, drops its text, and is the Master\'s or the operator\'s alone', () => {
      const [a, b] = [waiting('a'), waiting('b')];
      const items = claim();
      fail(items[0], 'rejected-by-chat');
      fail(items[1], 'part-conflict');
      const byMaster = decide('outbound-withdraw', a);
      const byOperator = decide('outbound-withdraw', b, { actor: 'operator' });
      for (const [result, id] of [[byMaster, a], [byOperator, b]]) {
        assert.deepEqual([result.outcome, result.item.state, result.item.dropCode, result.item.blockCode, result.item.text], ['applied', 'dropped', 'withdrawn', null, null]);
        assert.equal(decide('outbound-requeue', id).outcome, 'not-blocked', 'a withdrawn item cannot be put back');
        assert.equal(decide('outbound-withdraw', id).outcome, 'not-waiting');
      }
      assert.equal(seal(items[0], ['d100']).body.code, 'LEASE_LAPSED', 'the helper that held it is told only that its lease lapsed');
      const audit = store.getDb().prepare("SELECT actor, proof, master_generation, outcome FROM bridge_audit WHERE op = 'outbound-withdraw' AND outcome = 'applied' ORDER BY audit_seq").all();
      assert.deepEqual(audit.map((r) => [r.actor, r.proof, r.master_generation]), [['master', 'master-launch', 1], ['operator', 'verified-session', null]]);
      assert.equal(decide('outbound-withdraw', 9999).outcome, 'outbound-not-found');
    });

    describe('a withdrawal that would take a route with it', () => {
      /**
       * A released route with its unposted answer and one waiting notice about it.
       * @param {string} n - Distinguishes it.
       * @returns {{routeId: string, answer: number, notice: number}}
       */
      const releasedRoute = (n) => {
        const routeId = `rt_cascade_${n}`;
        bridgeStore.routes.accept({ routeId, externalId: `ext-${n}`, authorId: 'author', spaceId: 'space', channelId: 'channel', text: 'q', digest: bridgeStore.digest('q'), at: T0 });
        const released = bridgeStore.applyRouteWrite({
          op: 'answer', requestId: `req-answer-${n}-0000`, routeId, expectedVersion: bridgeStore.routes.get(routeId).version, actor: 'master', proof: 'master-launch', masterGeneration: 1, at: T0,
          change: () => ({
            set: { state: 'released' }, body: { role: 'answer', text: 'the answer', digest: bridgeStore.digest('the answer') },
            outbound: { idemKey: `route:${routeId}:answer`, kind: 'reply', sourceLabel: 'Project Master', text: 'the answer', digest: bridgeStore.digest('the answer'), releasedGeneration: 1 }
          })
        });
        assert.equal(released.outcome, 'applied');
        assert.equal(bridgeStore.outbound.enqueueStatus(routeId, 'pending', { at: T0 }).created, true);
        const ids = store.getDb().prepare('SELECT outbound_id, kind FROM bridge_outbound WHERE route_id = ? ORDER BY outbound_id').all(routeId);
        return { routeId, answer: ids.find((r) => r.kind === 'reply').outbound_id, notice: ids.find((r) => r.kind !== 'reply').outbound_id };
      };
      it('an answer that is no longer there to deliver leaves its route released, and the refusal is on the record', () => {
        const r = releasedRoute('unapplied');
        const item = claimOnly(r.answer, r);
        // Set aside under the helper's live lease: the acknowledgement is in order, the item is not.
        store.getDb().prepare("UPDATE bridge_outbound SET state = 'blocked', block_code = 'rejected-by-chat' WHERE outbound_id = ?").run(r.answer);
        const before = everything(r);
        let answered;
        const logged = warnings(() => { answered = seal(item, ['dA00']); });
        assert.deepEqual([answered.status, answered.body.code], [409, 'ACK_NOT_APPLIED']);
        assert.equal(everything(r), before, 'the route is not closed, its answer not cleared, the lease not settled');
        assert.equal(bridgeStore.routes.get(r.routeId).state, 'released');
        assert.equal(logged.length, 1, 'once');
        assert.match(logged[0], new RegExp(`Bridge acknowledgement was not applied outboundId=${r.answer} routeId=${r.routeId} outcome=[a-z-]+$`));
        assert.ok(!logged[0].includes('the answer'), 'ids and the outcome only: nothing of what was said');
      });

      const everything = (r) => JSON.stringify([
        bridgeStore.routes.get(r.routeId), bridgeStore.routes.body(r.routeId, 'answer'),
        store.getDb().prepare('SELECT outbound_id, state, drop_code, block_code, text FROM bridge_outbound WHERE route_id = ? ORDER BY outbound_id').all(r.routeId),
        store.getDb().prepare("SELECT outbound_id, state FROM bridge_outbound_leases ORDER BY lease_id").all()
      ]);
      const close = (r) => bridgeStore.applyRouteWrite({
        op: 'close', requestId: `req-close-${++seq}-0000`, routeId: r.routeId, expectedVersion: bridgeStore.routes.get(r.routeId).version,
        actor: 'master', proof: 'master-launch', masterGeneration: 1, at: gateway._deps.now(),
        change: () => ({ set: { state: 'closed', closed_by: 'master', closed_at: gateway._deps.now() }, withdraw: true, clearBodies: true })
      });
      /** The helper takes exactly one item, by leaving only it ready for the pass. */
      const claimOnly = (id, r) => {
        const others = [r.answer, r.notice].filter((x) => x !== id);
        const db = store.getDb();
        for (const o of others) db.prepare("UPDATE bridge_outbound SET state = 'blocked', block_code = 'rejected-by-chat' WHERE outbound_id = ?").run(o);
        const got = claim();
        for (const o of others) db.prepare("UPDATE bridge_outbound SET state = 'ready', block_code = NULL WHERE outbound_id = ?").run(o);
        assert.deepEqual(got.map((i) => i.outboundId), [id]);
        return got[0];
      };

      it('closing a route is refused while the helper holds any item of it, whatever the caller checked, and nothing changes', () => {
        const r = releasedRoute('close');
        claimOnly(r.notice, r);
        const before = everything(r);
        // The store itself refuses: this write did not ask first, as the route's own handler does.
        const refused = close(r);
        assert.deepEqual([refused.outcome, refused.route.state], ['outbound-in-flight', 'released']);
        assert.equal(everything(r), before, 'the route, its text, every item and every lease are as they were');
        assert.equal(bridgeStore.audit.forRoute(r.routeId).filter((a) => a.op === 'close').map((a) => a.outcome).join(), 'outbound-in-flight');
        // The token is revoked: every lease it held ends, and the close goes through.
        bridgeStore.helperTokens.revoke({ at: gateway._deps.now() });
        const closed = close(r);
        assert.deepEqual([closed.outcome, closed.route.state], ['applied', 'closed']);
        assert.deepEqual([r.answer, r.notice].map((id) => [bridgeStore.outbound.get(id).state, bridgeStore.outbound.get(id).dropCode]), [['dropped', 'withdrawn'], ['dropped', 'withdrawn']]);
      });

      it('and after the lease has genuinely run out, with nothing posted', () => {
        const r = releasedRoute('expiry');
        claimOnly(r.answer, r);
        assert.equal(close(r).outcome, 'outbound-in-flight');
        clockAt(LEASE);
        assert.equal(close(r).outcome, 'outbound-in-flight', 'at exactly the end of the window it is still the helper\'s');
        clockAt(LEASE + 1);
        assert.equal(close(r).outcome, 'applied');
      });

      it('withdrawing a route\'s answer is refused while the helper holds another item of that route', () => {
        const r = releasedRoute('answer');
        const held = claimOnly(r.notice, r);
        const before = everything(r);
        for (const actor of ['master', 'operator']) {
          const refused = decide('outbound-withdraw', r.answer, { actor });
          assert.deepEqual([refused.outcome, refused.item.state], ['outbound-in-flight', 'ready'], actor);
        }
        assert.equal(everything(r), before, 'the answer is still to be posted, the route still released, the notice still the helper\'s');
        const audited = store.getDb().prepare("SELECT outcome, detail_json FROM bridge_audit WHERE op = 'outbound-withdraw' ORDER BY audit_seq").all();
        assert.deepEqual(audited.map((a) => [a.outcome, JSON.parse(a.detail_json).routeId]), [['outbound-in-flight', r.routeId], ['outbound-in-flight', r.routeId]]);
        // The post the helper was making is still good.
        assert.equal(seal(held, ['d300']).status, 200);
        // And with nothing of the route in anyone's hands, the answer is withdrawn and the route closes.
        const done = decide('outbound-withdraw', r.answer);
        assert.equal(done.outcome, 'applied');
        assert.equal(bridgeStore.routes.get(r.routeId).state, 'closed');
        // A notice that is about no released answer is unaffected by any of this.
        const lone = releasedRoute('lone');
        claimOnly(lone.answer, lone);
        assert.equal(decide('outbound-withdraw', lone.notice).outcome, 'applied', 'withdrawing a notice closes no route, so the answer in flight is not its concern');
        assert.equal(bridgeStore.routes.get(lone.routeId).state, 'released');
      });

      it('a circuit reset that withdraws is refused whole while the helper holds an item of a route it would close', () => {
        const r = releasedRoute('reset');
        // One pass hands the helper both. The answer cannot be posted and opens the circuit; the notice is still in its hands.
        const got = claim();
        assert.deepEqual(got.map((i) => i.outboundId).sort(), [r.answer, r.notice].sort());
        assert.equal(fail(got.find((i) => i.outboundId === r.answer), 'chat-channel-missing').body.circuit.opened, true);
        const before = everything(r);
        const reset = (decision) => bridgeStore.applyCircuitReset({ requestId: `req-reset-${++seq}-0000`, decision, actor: 'master', proof: 'master-launch', masterGeneration: 1, at: gateway._deps.now() });
        const refused = reset('withdraw');
        assert.deepEqual([refused.outcome, refused.items], ['outbound-in-flight', 0]);
        assert.equal(everything(r), before);
        assert.ok(bridgeStore.circuit.open(), 'the episode is still open');
        clockAt(LEASE + 1);
        assert.equal(reset('withdraw').outcome, 'applied');
        assert.equal(bridgeStore.routes.get(r.routeId).state, 'closed');
      });
    });

    it('an item in the helper\'s hands is not withdrawn: the withdrawal waits for the lease to settle', () => {
      const id = waiting('a');
      const [item] = claim();
      const refused = decide('outbound-withdraw', id);
      assert.deepEqual([refused.outcome, refused.item.state], ['outbound-in-flight', 'ready']);
      assert.equal(seal(item, ['d100']).status, 200, 'and the post it was about to make is still good');
      assert.equal(decide('outbound-withdraw', id).outcome, 'not-waiting', 'what is delivered is history');

      const other = waiting('b');
      const [held] = claim();
      assert.equal(decide('outbound-withdraw', other).outcome, 'outbound-in-flight');
      clockAt(LEASE + 1);
      assert.equal(decide('outbound-withdraw', other).outcome, 'applied', 'once the lease has lapsed');
      assert.deepEqual([seal(held, ['d200']).status, seal(held, ['d200']).body.code], [409, 'LEASE_LAPSED']);
      assert.deepEqual(claim(), [], 'and it is never handed over again');
    });

    it('a request id belongs to one decision about one item', () => {
      const [a, b] = [waiting('a'), waiting('b')];
      const items = claim();
      fail(items[0], 'rejected-by-chat');
      fail(items[1], 'rejected-by-chat');
      assert.equal(decide('outbound-requeue', a, { requestId: 'req-shared-0001' }).outcome, 'applied');
      const reused = decide('outbound-requeue', b, { requestId: 'req-shared-0001' });
      assert.deepEqual([reused.outcome, reused.item.state], ['request-id-reused', 'blocked']);
    });

    it('an item set aside still has a limit, and is let go when it passes', () => {
      const id = waiting('a');
      fail(claim()[0], 'rejected-by-chat');
      assert.equal(bridgeStore.expire({ now: at(7 * DAY) }).outbound, 0, 'at exactly the limit it stays');
      // The item, and the notice raised about it at the same instant.
      assert.equal(bridgeStore.expire({ now: at(7 * DAY + 1) }).outbound, 2);
      assert.deepEqual([bridgeStore.outbound.get(id).state, bridgeStore.outbound.get(id).blockCode, bridgeStore.outbound.get(id).text], ['dropped', null, null]);
      assert.equal(decide('outbound-requeue', id).outcome, 'not-blocked');
    });
  });
});
