'use strict';

// #2031 (ADR 0023): the operator bridge's gateway, driven through its real
// store, real project, session and launch rows, and the real tracked-send
// path; only the Hub's wire, the Master pane and the clock are stand-ins. A
// message goes in from the helper, to its destination, and comes back held;
// nothing a destination says is relayed until Master releases it; and only the
// exact session the message was sent to can answer it.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const bridgeStore = require('../lib/bridge-store');
const gateway = require('../lib/bridge-gateway');
const exchanges = require('../lib/medusa-exchanges');
const watchdog = require('../lib/medusa-watchdog');
const bridgeNotify = require('../lib/bridge-notify');
const { install, masterTakesSuggestion, GATEWAY_WS, MASTER_WS } = require('./_bridge-hub');

const ALLOWED = { authorId: 'author1', spaceId: 'space1', channelId: 'chan1' };

let tmpDir;
let clock;
let realNotifyNow;
let hub;
let masterState;
let realDeps;
let realExchangeNow;

/**
 * A project with a live, launch-bound session and a workspace.
 * @param {string} name - Project name.
 * @returns {{project: object, sessionId: number, launchId: string, workspaceId: string}}
 */
function liveProject(name) {
  return hub.liveProject(name, tmpDir);
}

/**
 * The reason each arrival was dropped, in order.
 * @returns {string[]}
 */
function dropReasons() {
  return gateway.droppedArrivals().recent.map((d) => d.reason);
}

/**
 * An inbound message from the allowlisted operator.
 * @param {string} externalId - Chat message id.
 * @param {string} text - Message text.
 * @param {object} [over] - Field overrides.
 * @returns {Promise<{status: number, body: object}>}
 */
function operatorWrites(externalId, text, over = {}) {
  return gateway.acceptInbound({ externalId, ...ALLOWED, text, ...over });
}

/**
 * The operator writes, and the Project Master routes the message where the
 * gateway suggested. Every inbound waits for that decision; most of this file
 * is about what happens after it. What comes back is the accept's own answer,
 * with the route's state as the decision left it.
 * @param {string} externalId - Chat message id.
 * @param {string} text - Message text.
 * @param {object} [over] - Field overrides.
 * @returns {Promise<{status: number, body: object}>}
 */
async function operatorSays(externalId, text, over = {}) {
  const accepted = await operatorWrites(externalId, text, over);
  if (accepted.status !== 202 || !accepted.body.routeId || accepted.body.replayed) return accepted;
  const route = await masterTakesSuggestion(accepted.body.routeId, { at: clock });
  return { status: accepted.status, body: { ...accepted.body, state: route ? route.state : accepted.body.state } };
}

/**
 * A route written straight into the store is handed to the Master, and the
 * Master routes it where the gateway suggested.
 * @param {string} routeId - Route id.
 * @param {object} [options] - `advance: false` leaves it routed and not yet sent.
 * @returns {Promise<object|null>} The route afterwards.
 */
async function handedOverAndRouted(routeId, options = {}) {
  await gateway.advance(routeId);
  return masterTakesSuggestion(routeId, { at: clock, ...options });
}

/**
 * What the gateway suggested for a route when it handed it to the Master.
 * @param {string} routeId - Route id.
 * @returns {{by: (string|null), to: (string|null), projectId: (number|null), reason: (string|null)}|null}
 */
function suggested(routeId) {
  return bridgeStore.audit.suggestionFor(routeId);
}

/**
 * The helper token in force, minting one when there is none.
 * @returns {{tokenId: string}}
 */
function helper() {
  return bridgeStore.helperTokens.active() || gateway.mintHelperToken();
}

/**
 * What waits to be posted, oldest first, without claiming any of it.
 * @returns {object[]}
 */
function waitingForHelper() {
  return bridgeStore.outbound.ready().map((item) => ({
    outboundId: item.outboundId, kind: item.kind, sourceLabel: item.sourceLabel, text: item.text,
    inReplyTo: item.routeId ? { externalId: bridgeStore.routes.get(item.routeId).externalId } : null
  }));
}

let claimSeq = 0;

/**
 * Collect what waits, as the helper does.
 * @param {object} [options] - `limit`, and `nonce` to repeat a claim.
 * @returns {{status: number, body: object}}
 */
function helperClaims(options = {}) {
  return gateway.claimOutbound(helper(), options.nonce || `claim-nonce-${String(++claimSeq).padStart(8, '0')}`, { limit: options.limit });
}

/**
 * Acknowledge a claimed item under its lease.
 * @param {{outboundId: number, leaseId: string}} item - A claimed item.
 * @param {string} deliveredRef - The chat's id for the post.
 * @returns {{status: number, body: object}}
 */
function helperAcks(item, deliveredRef) {
  return gateway.acknowledgeOutbound(item.outboundId, deliveredRef, { leaseId: item.leaseId, tokenId: helper().tokenId });
}

/**
 * Advance the stand-in clock.
 * @param {number} ms - Milliseconds.
 * @returns {void}
 */
function later(ms) {
  clock = new Date(Date.parse(clock) + ms).toISOString();
}

describe('bridge gateway (#2031)', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-bridge-gateway-'));
    store._setBasePath(tmpDir);
    store.init();
    clock = '2026-10-04T00:00:00.000Z';
    // The notifier judges "how long ago" by its own clock. Left on the real one it measured this
    // file's fixed 2026-10-04 timeline against today, and every notification test here began to
    // fail a day after that date. It gets the test's clock, like everything else in this file.
    realNotifyNow = bridgeNotify._deps.now;
    bridgeNotify._deps.now = () => clock;
    hub = install();
    masterState = { live: true, ensures: 0, ensureError: null, listening: true };
    realDeps = { ...gateway._deps };
    let n = 0;
    Object.assign(gateway._deps, {
      master: () => ({
        masterLiveness: () => ({ live: masterState.live, answered: true, cause: null }),
        ensureMasterSession: () => {
          masterState.ensures += 1;
          if (masterState.ensureError) return { created: false, error: masterState.ensureError };
          masterState.live = true;
          return { created: true };
        },
        getMasterMedusaStatus: () => ({ workspaceId: masterState.listening ? MASTER_WS : null }),
        masterListenerEnabled: () => true
      }),
      now: () => clock,
      id: (prefix) => `${prefix}_${++n}`
    });
    // One clock for the gateway and for the exchange rows it reads the age of.
    realExchangeNow = exchanges._internal.now;
    exchanges._internal.now = () => new Date(clock);
    gateway._reset();
    bridgeStore.settings.set('enabled', 'true');
    bridgeStore.settings.set('allow.author', ALLOWED.authorId);
    bridgeStore.settings.set('allow.space', ALLOWED.spaceId);
    bridgeStore.settings.set('allow.channel', ALLOWED.channelId);
  });

  afterEach(() => {
    Object.assign(gateway._deps, realDeps);
    bridgeNotify._deps.now = realNotifyNow;
    exchanges._internal.now = realExchangeNow;
    hub.restore();
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('accepting', () => {
    it('accepts nothing while disabled, and stores nothing', async () => {
      bridgeStore.settings.set('enabled', 'false');
      const r = await operatorSays('m1', 'hello');
      assert.deepEqual([r.status, r.body.code], [409, 'BRIDGE_DISABLED']);
      assert.equal(bridgeStore.routes.list().length, 0);
      assert.equal(masterState.ensures, 0, 'a disabled bridge cannot launch the Master');
    });

    it('refuses anyone but the allowlisted author, space and channel, keeping none of the message', async () => {
      for (const over of [{ authorId: 'someone' }, { spaceId: 'elsewhere' }, { channelId: 'other' }]) {
        const r = await operatorSays('m1', 'secret text', over);
        assert.deepEqual([r.status, r.body.code], [403, 'NOT_ALLOWLISTED']);
      }
      assert.equal(bridgeStore.routes.list().length, 0);
      const dump = JSON.stringify(store.getDb().prepare('SELECT * FROM bridge_audit').all());
      assert.ok(!dump.includes('secret text'));
      assert.equal(store.getDb().prepare("SELECT COUNT(*) AS n FROM bridge_audit WHERE outcome = 'not-allowlisted'").get().n, 3);
    });

    it('refuses until the operator has set the allowlist', async () => {
      bridgeStore.settings.set('allow.channel', null);
      assert.equal((await operatorSays('m1', 'hello')).body.code, 'ALLOWLIST_NOT_SET');
    });

    it('stores a replayed message once and refuses the same id with different text', async () => {
      const first = await operatorSays('m1', 'hello');
      const again = await operatorSays('m1', 'hello');
      assert.deepEqual([first.status, again.status, again.body.replayed, again.body.routeId], [202, 200, true, first.body.routeId]);
      assert.equal((await operatorSays('m1', 'something else')).body.code, 'EXTERNAL_ID_MISMATCH');
      assert.equal(store.getDb().prepare('SELECT COUNT(*) AS n FROM bridge_routes').get().n, 1);
    });

    it('refuses a malformed or over-long message', async () => {
      assert.equal((await operatorSays('bad id!', 'x')).body.code, 'BAD_INBOUND');
      assert.equal((await operatorSays('m2', '   ')).body.code, 'BAD_INBOUND');
      assert.equal((await operatorSays('m3', 'x'.repeat(8001))).body.code, 'INBOUND_TOO_LONG');
    });
  });

  describe('resolving', () => {
    it('no inbound goes anywhere until the Master routes it: an address, a reply, a pin and the default are suggestions only', async () => {
      const alpha = liveProject('Alpha');
      const beta = liveProject('Beta');
      bridgeStore.aliases.set('arch', { kind: 'project', projectId: beta.project.id });
      // An earlier, decided route for the reply to inherit from; everything after it is left undecided.
      await operatorSays('m0', '@alpha first');
      const sentBefore = hub.fromGateway().length;
      bridgeStore.pins.setConversation({ pinId: 'p-thread', conversationKey: 'chan1:thread9', destination: { kind: 'project', projectId: beta.project.id }, masterGeneration: 1 });
      const CASES = [
        ['an exact project name', 'e1', '@alpha please', {}, { by: 'alias', to: 'project', projectId: alpha.project.id, reason: null }],
        ['an operator nickname', 'e2', '@arch please', {}, { by: 'alias', to: 'project', projectId: beta.project.id, reason: null }],
        ['the reserved @master', 'e3', '@master please', {}, { by: 'alias', to: 'master', projectId: null, reason: null }],
        ['a reply to a routed message', 'e4', 'and another thing', { replyToExternalId: 'm0' }, { by: 'reply-inheritance', to: 'project', projectId: alpha.project.id, reason: null }],
        ['a pinned conversation', 'e5', 'unaddressed, in the pinned thread', { threadId: 'thread9' }, { by: 'pin', to: 'project', projectId: beta.project.id, reason: null }],
        ['nothing at all', 'e6', 'unaddressed', {}, { by: 'default', to: 'master', projectId: null, reason: null }],
        ['an address that matches nothing', 'e7', '@nobody hi', {}, { by: null, to: null, projectId: null, reason: 'address-unresolved' }]
      ];
      const ids = [];
      for (const [why, externalId, text, over, suggestion] of CASES) {
        const accepted = await operatorWrites(externalId, text, over);
        assert.equal(accepted.status, 202, why);
        const route = bridgeStore.routes.get(accepted.body.routeId);
        ids.push(route.routeId);
        assert.deepEqual([route.state, route.destination, route.resolvedBy], ['awaiting-master', null, null], `${why}: waiting, with no destination`);
        assert.deepEqual(suggested(route.routeId), suggestion, `${why}: what was found is on the record as a suggestion`);
        assert.equal(bridgeStore.proofs.latestToTarget(route.routeId), null, `${why}: nothing was sent, so there is no proof of a send`);
      }
      assert.equal(hub.fromGateway().length, sentBefore, 'not one of them reached a project');
      // Nothing applies a suggestion later: not a pass, not time, not a restart, not a pin, not the same message again.
      for (let i = 0; i < 3; i++) { later(10 * 60 * 1000); await gateway.tick(); }
      gateway._reset();
      await gateway.tick();
      bridgeStore.pins.setGlobal({ pinId: 'p-late', conversationKey: null, destination: { kind: 'project', projectId: alpha.project.id } });
      await gateway.tick();
      for (const [, externalId, text, over] of CASES) assert.equal((await operatorWrites(externalId, text, over)).body.replayed, true);
      for (const id of ids) await gateway.advance(id);
      assert.equal(hub.fromGateway().length, sentBefore, 'still nothing sent');
      for (const id of ids) assert.deepEqual([bridgeStore.routes.get(id).state, bridgeStore.routes.get(id).destination], ['awaiting-master', null]);
      // The suggestion on record is the one made when the route arrived, not rewritten by the later pin.
      assert.equal(suggested(ids[5]).by, 'default');
      // The Master's decision is what moves one, and it may differ from the suggestion.
      const decided = bridgeStore.applyRouteWrite({
        op: 'route', requestId: 'req-decide-against-0001', routeId: ids[0], expectedVersion: bridgeStore.routes.get(ids[0]).version,
        actor: 'master', proof: 'master-launch', masterGeneration: 1, at: clock,
        change: (current) => (current.state !== 'awaiting-master' ? { refuse: 'not-awaiting-master' }
          : { set: { state: 'accepted', resolved_by: 'master', destination_kind: 'project', destination_project_id: beta.project.id, resolved_generation: 1, failure_code: null } })
      });
      assert.equal(decided.outcome, 'applied');
      const routed = await gateway.advance(ids[0]);
      assert.deepEqual([routed.state, routed.resolvedBy, routed.destination.projectId], ['routed', 'master', beta.project.id], 'sent where the Master said, not where the address pointed');
      assert.equal(hub.fromGateway().at(-1).to, beta.workspaceId);
      assert.equal(hub.fromGateway().length, sentBefore + 1);
      assert.deepEqual(bridgeStore.audit.forRoute(ids[0]).filter((a) => a.outcome === 'applied').map((a) => [a.op, a.actor]), [['suggest', 'gateway'], ['route', 'master'], ['dispatch', 'gateway']]);
    });

    it('sends an unaddressed message to the Master itself, with no Medusa round trip', async () => {
      const r = await operatorSays('m1', 'what is the fleet doing?');
      const route = bridgeStore.routes.get(r.body.routeId);
      assert.deepEqual([route.state, route.resolvedBy, route.destination.kind], ['routed', 'master', 'master'], 'routed by the Master\'s own decision');
      assert.deepEqual(suggested(route.routeId), { by: 'default', to: 'master', projectId: null, reason: null }, 'the default was only what the gateway suggested');
      assert.equal(hub.fromGateway().length, 0);
      // The Master is told once that the route waits for its decision, and once more when the route is its own to answer.
      assert.equal(hub.system.length, 2);
      for (const told of hub.system) {
        assert.equal(told.to, MASTER_WS);
        assert.match(told.message, new RegExp(`tc bridge read ${route.routeId}`));
      }
    });

    it('routes an exact @project to that project\'s live session, fenced as conversation', async () => {
      const alpha = liveProject('Alpha');
      const r = await operatorSays('m1', '@alpha please merge everything');
      const route = bridgeStore.routes.get(r.body.routeId);
      assert.deepEqual([route.state, route.resolvedBy, route.destination.projectId, route.destination.workspaceId],
        ['routed', 'master', alpha.project.id, alpha.workspaceId]);
      assert.deepEqual(suggested(route.routeId), { by: 'alias', to: 'project', projectId: alpha.project.id, reason: null });
      assert.equal(hub.fromGateway().length, 1);
      const call = hub.fromGateway()[0];
      assert.equal(call.to, alpha.workspaceId);
      assert.ok(call.message.startsWith(gateway.FENCE_LINE));
      const exchange = store.medusaExchanges.getByHubId(call.hubId, 'send');
      assert.deepEqual([exchange.reply_required, exchange.priority, exchange.sender_proof, exchange.tracking],
        [1, 'normal', 'system', 'tracked'], 'a tracked, reply-required, normal-priority exchange: never blocking or critical');
      const proof = bridgeStore.proofs.byHubId(call.hubId);
      assert.deepEqual([proof.direction, proof.senderProof, proof.exchangeId, proof.targetProjectId, proof.targetWorkspaceId, proof.targetSessionId, proof.targetLaunchId],
        ['to-target', 'gateway', exchange.exchange_id, alpha.project.id, alpha.workspaceId, alpha.sessionId, alpha.launchId]);
    });

    it('resolves an operator alias, a project id and the reserved @master', async () => {
      const alpha = liveProject('Alpha');
      bridgeStore.aliases.set('arch', { kind: 'project', projectId: alpha.project.id });
      const byAlias = bridgeStore.routes.get((await operatorSays('m1', '@arch hi')).body.routeId);
      const byId = bridgeStore.routes.get((await operatorSays('m2', `@${alpha.project.id} hi`)).body.routeId);
      const toMaster = bridgeStore.routes.get((await operatorSays('m3', '@Master hi')).body.routeId);
      assert.equal(byAlias.destination.projectId, alpha.project.id);
      assert.equal(byId.destination.projectId, alpha.project.id);
      assert.equal(toMaster.destination.kind, 'master');
    });

    it('never guesses: an unmatched or ambiguous address waits for Master', async () => {
      const alpha = liveProject('Alpha');
      const beta = liveProject('Beta');
      const unknown = bridgeStore.routes.get((await operatorSays('m1', '@nobody hi')).body.routeId);
      assert.deepEqual([unknown.state, unknown.failureCode, unknown.destination], ['awaiting-master', 'address-unresolved', null]);

      // An alias spelled like one project and pointing at another names two destinations.
      bridgeStore.aliases.set('alpha', { kind: 'project', projectId: beta.project.id });
      const ambiguous = bridgeStore.routes.get((await operatorSays('m2', '@alpha hi')).body.routeId);
      assert.deepEqual([ambiguous.state, ambiguous.failureCode], ['awaiting-master', 'address-ambiguous']);
      assert.equal(hub.fromGateway().length, 0);
      assert.ok(alpha.project.id !== beta.project.id);
    });

    it('does not read a chat mention or a mid-sentence @ as an address', async () => {
      liveProject('Alpha');
      const mention = bridgeStore.routes.get((await operatorSays('m1', '<@12345> hello')).body.routeId);
      const middle = bridgeStore.routes.get((await operatorSays('m2', 'ask @alpha about it')).body.routeId);
      assert.equal(suggested(mention.routeId).by, 'default');
      assert.equal(suggested(middle.routeId).by, 'default');
      assert.deepEqual([mention.destination.kind, middle.destination.kind], ['master', 'master']);
    });

    it('a reply inherits its route; a pin outranks the default; the operator\'s pin outranks Master\'s', async () => {
      const alpha = liveProject('Alpha');
      const beta = liveProject('Beta');
      await operatorSays('m1', '@alpha first');
      const reply = bridgeStore.routes.get((await operatorSays('m2', 'and another thing', { replyToExternalId: 'm1' })).body.routeId);
      assert.deepEqual([suggested(reply.routeId).by, reply.destination.projectId], ['reply-inheritance', alpha.project.id]);

      bridgeStore.pins.setConversation({ pinId: 'p1', conversationKey: 'chan1', destination: { kind: 'project', projectId: alpha.project.id }, masterGeneration: 1 });
      const pinned = bridgeStore.routes.get((await operatorSays('m3', 'unaddressed')).body.routeId);
      assert.deepEqual([suggested(pinned.routeId).by, pinned.destination.projectId], ['pin', alpha.project.id]);

      bridgeStore.pins.setGlobal({ pinId: 'p2', conversationKey: 'chan1', destination: { kind: 'project', projectId: beta.project.id } });
      const operatorPinned = bridgeStore.routes.get((await operatorSays('m4', 'unaddressed')).body.routeId);
      assert.equal(operatorPinned.destination.projectId, beta.project.id);
    });

    it('a destination fixed on a waiting route is not moved by a later pin', async () => {
      const alpha = liveProject('Alpha');
      const beta = liveProject('Beta');
      const r = await operatorSays('m1', '@alpha first');
      bridgeStore.pins.setGlobal({ pinId: 'p1', conversationKey: null, destination: { kind: 'project', projectId: beta.project.id } });
      await gateway.tick();
      assert.equal(bridgeStore.routes.get(r.body.routeId).destination.projectId, alpha.project.id);
    });
  });

  describe('holding the reply', () => {
    it('holds the destination\'s reply for Master and posts nothing', async () => {
      const alpha = liveProject('Alpha');
      const r = await operatorSays('m1', '@alpha status?');
      const sent = await hub.sessionSends(alpha, { inReplyTo: hub.fromGateway()[0].hubId, text: 'all green' });
      assert.equal(sent.status, 200);
      assert.deepEqual(gateway.drainInbox(), { held: 1, dropped: 0, waiting: 0 });
      await gateway.tick();

      const route = bridgeStore.routes.get(r.body.routeId);
      assert.equal(route.state, 'reply-held');
      assert.equal(bridgeStore.routes.body(route.routeId, 'reply').text, 'all green');
      assert.deepEqual(waitingForHelper(), [], 'nothing reaches the helper before Master releases it');
      assert.deepEqual(hub.handled, [sent.body.id]);
      assert.match(hub.system[hub.system.length - 1].message, /has a reply held for your release/);
      const audit = bridgeStore.audit.forRoute(route.routeId).pop();
      assert.deepEqual([audit.op, audit.actor, audit.proof], ['reply-held', 'session', 'launch']);
      const proof = bridgeStore.proofs.byHubId(sent.body.id);
      assert.deepEqual([proof.direction, proof.senderProof], ['from-target', 'launch']);
    });

    it('a reply whose route moved as it was being stored is kept and judged again; one the store will not take is dropped for that reason', async () => {
      const alpha = liveProject('Alpha');
      const r = await operatorSays('m1', '@alpha status?');
      await hub.sessionSends(alpha, { inReplyTo: hub.fromGateway()[0].hubId, text: 'All green.' });
      const realApply = bridgeStore.applyRouteWrite;
      let answers = ['version-conflict', 'refused'];
      bridgeStore.applyRouteWrite = (write) => (write.op === 'reply-held' && answers.length
        ? { outcome: answers.shift(), replayed: false, route: bridgeStore.routes.get(write.routeId) }
        : realApply(write));
      try {
        // The route moved under it: nothing is lost, and nothing is handled yet.
        assert.deepEqual(gateway.drainInbox(), { held: 0, dropped: 0, waiting: 1 });
        assert.deepEqual([hub.handled.length, dropReasons()], [0, []]);
        assert.equal(bridgeStore.routes.get(r.body.routeId).state, 'routed');
        // The store will not take it, for a reason of its own: that is a drop, and it says why.
        assert.deepEqual(gateway.drainInbox(), { held: 0, dropped: 1, waiting: 0 });
        assert.deepEqual(dropReasons(), ['not-applied:refused']);
        assert.equal(gateway.droppedArrivals().recent[0].routeId, r.body.routeId);
      } finally {
        bridgeStore.applyRouteWrite = realApply;
      }
      // Asked again with nothing in the way, a reply that waited is held.
      const beta = liveProject('Beta');
      const second = await operatorSays('m2', '@beta status?');
      await hub.sessionSends(beta, { inReplyTo: hub.fromGateway()[1].hubId, text: 'Also green.' });
      answers = ['version-conflict'];
      bridgeStore.applyRouteWrite = (write) => (write.op === 'reply-held' && answers.length
        ? { outcome: answers.shift(), replayed: false, route: bridgeStore.routes.get(write.routeId) }
        : realApply(write));
      try {
        assert.equal(gateway.drainInbox().waiting, 1);
        assert.equal(gateway.drainInbox().held, 1);
      } finally {
        bridgeStore.applyRouteWrite = realApply;
      }
      assert.equal(bridgeStore.routes.get(second.body.routeId).state, 'reply-held');
      assert.equal(bridgeStore.routes.body(second.body.routeId, 'reply').text, 'Also green.');
    });

    it('captures a reply once, however often it is seen', async () => {
      const alpha = liveProject('Alpha');
      const r = await operatorSays('m1', '@alpha status?');
      const sent = await hub.sessionSends(alpha, { inReplyTo: hub.fromGateway()[0].hubId });
      gateway.drainInbox();
      hub.inbox.push({ id: sent.body.id, from: alpha.workspaceId, message: 'the answer' });
      gateway.drainInbox();
      const route = bridgeStore.routes.get(r.body.routeId);
      assert.equal(route.version, 5, 'suggest, route, dispatch, reply-held: no fifth write');
      assert.equal(bridgeStore.audit.forRoute(route.routeId).filter((a) => a.op === 'reply-held').length, 1);
    });

    it('does not accept a reply from another live session of the same project', async () => {
      const alpha = liveProject('Alpha');
      const r = await operatorSays('m1', '@alpha status?');
      // Verified, launch-bound, in the right project, answering the right
      // message: everything but being the session it was sent to.
      const target = alpha;
      const sibling = hub.anotherSession(alpha.project);
      const sent = await hub.sessionSends(sibling, { inReplyTo: hub.fromGateway()[0].hubId });
      assert.equal(sent.status, 200, 'the Medusa layer accepts it: both sessions belong to the project');
      assert.equal(gateway.drainInbox().dropped, 1);
      assert.deepEqual(dropReasons(), ['sender-is-another-session']);
      assert.equal(bridgeStore.routes.get(r.body.routeId).state, 'routed');
      assert.ok(target.sessionId !== sibling.sessionId);
    });

    it('does not accept a reply from the target after its session was relaunched', async () => {
      const alpha = liveProject('Alpha');
      const r = await operatorSays('m1', '@alpha status?');
      // The same session row now runs under a different launch.
      store.getDb().prepare('UPDATE launch_sequences SET launch_id = ? WHERE session_id = ?').run('a-newer-launch', alpha.sessionId);
      await hub.sessionSends(alpha, { inReplyTo: hub.fromGateway()[0].hubId });
      assert.equal(gateway.drainInbox().dropped, 1);
      assert.deepEqual(dropReasons(), ['sender-is-another-launch']);
      assert.equal(bridgeStore.routes.get(r.body.routeId).state, 'routed');
    });

    it('drops, each for its own reason, what is not a reply to the message the bridge sent', async () => {
      const alpha = liveProject('Alpha');
      const r = await operatorSays('m1', '@alpha status?');
      const asked = hub.fromGateway()[0].hubId;

      // An ordinary message to the gateway that answers nothing.
      await hub.sessionSends(alpha, { text: 'unprompted' });
      assert.equal(gateway.drainInbox().dropped, 1);
      // A reply addressed to someone else that reached the gateway's inbox anyway.
      const elsewhere = await hub.sessionSends(alpha, { inReplyTo: asked, to: 'some-other-ws', deliver: false });
      hub.inbox.push({ id: elsewhere.body.id, from: alpha.workspaceId, message: 'the answer' });
      assert.equal(gateway.drainInbox().dropped, 1);
      // A watchdog or escalation notice.
      hub.inbox.push({ id: 'sys-9', from: 'system', message: 'an escalation notice' });
      assert.equal(gateway.drainInbox().dropped, 1);
      // Something with no id at all.
      hub.inbox.push({ from: alpha.workspaceId, message: 'no id' });
      assert.equal(gateway.drainInbox().dropped, 1);

      assert.deepEqual(dropReasons(), ['not-a-reply', 'not-addressed-to-the-gateway', 'system-notice', 'malformed']);
      assert.equal(bridgeStore.routes.get(r.body.routeId).state, 'routed');
      assert.equal(bridgeStore.routes.body(r.body.routeId, 'reply'), null);
      assert.deepEqual(waitingForHelper(), []);
    });

    it('the Medusa layer itself refuses a reply from an unverified caller or another project', async () => {
      const alpha = liveProject('Alpha');
      const beta = liveProject('Beta');
      await operatorSays('m1', '@alpha status?');
      const asked = hub.fromGateway()[0].hubId;
      const unbound = await hub.sessionSends(alpha, { inReplyTo: asked, caller: { kind: 'unbound' } });
      assert.deepEqual([unbound.status, unbound.body.code], [403, 'EXCHANGE_BINDING_REQUIRED']);
      const other = await hub.sessionSends(beta, { inReplyTo: asked });
      assert.deepEqual([other.status, other.body.code], [404, 'REPLY_TARGET_UNKNOWN']);
      assert.equal(hub.inbox.length, 0, 'neither was sent, so neither reached the gateway');
    });

    it('still drops a sender row the Medusa layer would never write: unverified, or not launch-proven', async () => {
      const alpha = liveProject('Alpha');
      const r = await operatorSays('m1', '@alpha status?');
      const bridgeExchange = bridgeStore.proofs.byHubId(hub.fromGateway()[0].hubId).exchangeId;
      const forge = (hubId, over) => {
        const row = {
          exchange_id: `mx_${hubId}`, request_id: `req-${hubId}`, hub_id: hubId, origin: 'send', tracking: 'untracked',
          sender_project_id: alpha.project.id, sender_session_id: String(alpha.sessionId), sender_workspace_id: alpha.workspaceId,
          sender_verified: 1, sender_proof: 'launch', recipient_workspace_id: GATEWAY_WS, priority: 'normal', reply_required: 0,
          in_reply_to: bridgeExchange, created_at: clock, state: 'untracked', updated_at: clock, ...over
        };
        const columns = Object.keys(row);
        store.getDb().prepare(`INSERT INTO medusa_exchanges (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
          .run(...columns.map((c) => row[c]));
        hub.inbox.push({ id: hubId, from: alpha.workspaceId, message: 'forged' });
      };
      forge('forged-1', { sender_verified: 0 });
      forge('forged-2', { sender_proof: 'ambient-open' });
      forge('forged-3', { sender_workspace_id: 'another-ws' });
      forge('forged-4', { in_reply_to: 'mx_not_the_bridges' });
      assert.equal(gateway.drainInbox().dropped, 4);
      assert.deepEqual(dropReasons(), [
        'sender-not-a-verified-launch', 'sender-not-a-verified-launch', 'sender-is-another-workspace', 'answers-nothing-the-bridge-sent'
      ]);
      assert.equal(bridgeStore.routes.get(r.body.routeId).state, 'routed');
    });

    it('does not accept a reply to a message that was superseded by a reroute', async () => {
      const alpha = liveProject('Alpha');
      const r = await operatorSays('m1', '@alpha status?');
      const first = hub.fromGateway()[0].hubId;
      // The first send is reported undeliverable; Master routes it again.
      store.getDb().prepare("UPDATE medusa_exchanges SET state = 'undeliverable' WHERE hub_id = ? AND origin = 'send'").run(first);
      await gateway.tick();
      const waiting = bridgeStore.routes.get(r.body.routeId);
      assert.equal(waiting.state, 'awaiting-master');
      bridgeStore.applyRouteWrite({
        op: 'route', requestId: 'req-reroute-0001', routeId: waiting.routeId, expectedVersion: waiting.version,
        actor: 'master', proof: 'master-launch', masterGeneration: 1,
        change: () => ({ set: { state: 'accepted', resolved_by: 'master', destination_kind: 'project', destination_project_id: alpha.project.id, resolved_generation: 1, failure_code: null } })
      });
      await gateway.advance(waiting.routeId);
      assert.equal(hub.fromGateway().length, 2, 'a reroute is a new send under a new request id');

      await hub.sessionSends(alpha, { inReplyTo: first, text: 'answer to the old one' });
      assert.equal(gateway.drainInbox().dropped, 1);
      assert.deepEqual(dropReasons(), ['answers-a-superseded-message']);
      await hub.sessionSends(alpha, { inReplyTo: hub.fromGateway()[1].hubId, text: 'answer to the new one' });
      assert.equal(gateway.drainInbox().held, 1);
      assert.equal(bridgeStore.routes.body(waiting.routeId, 'reply').text, 'answer to the new one');
    });

    it('drops a second reply once one is held, an empty reply, and a row naming another project', async () => {
      const alpha = liveProject('Alpha');
      const beta = liveProject('Beta');
      const r = await operatorSays('m1', '@alpha status?');
      const asked = hub.fromGateway()[0].hubId;

      // The Hub delivers a reply whose text is blank.
      const blank = await hub.sessionSends(alpha, { inReplyTo: asked, text: 'placeholder', deliver: false });
      hub.inbox.push({ id: blank.body.id, from: alpha.workspaceId, message: '   ' });
      assert.equal(gateway.drainInbox().dropped, 1);

      // A row the Medusa layer would never write: the right session, another project's id.
      const bridgeExchange = bridgeStore.proofs.byHubId(asked).exchangeId;
      const row = {
        exchange_id: 'mx_forged_project', request_id: 'req-forged-project', hub_id: 'forged-project', origin: 'send', tracking: 'untracked',
        sender_project_id: beta.project.id, sender_session_id: String(alpha.sessionId), sender_workspace_id: alpha.workspaceId,
        sender_verified: 1, sender_proof: 'launch', recipient_workspace_id: GATEWAY_WS, priority: 'normal', reply_required: 0,
        in_reply_to: bridgeExchange, created_at: clock, state: 'untracked', updated_at: clock
      };
      const columns = Object.keys(row);
      store.getDb().prepare(`INSERT INTO medusa_exchanges (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`)
        .run(...columns.map((c) => row[c]));
      hub.inbox.push({ id: 'forged-project', from: alpha.workspaceId, message: 'forged' });
      assert.equal(gateway.drainInbox().dropped, 1);

      await hub.sessionSends(alpha, { inReplyTo: asked, text: 'the real answer' });
      assert.equal(gateway.drainInbox().held, 1);
      await hub.sessionSends(alpha, { inReplyTo: asked, text: 'and another' });
      assert.equal(gateway.drainInbox().dropped, 1);

      assert.deepEqual(dropReasons(), ['empty-reply', 'sender-is-another-project', 'route-not-awaiting-a-reply']);
      assert.equal(bridgeStore.routes.body(r.body.routeId, 'reply').text, 'the real answer');
    });

    it('waits for a reply whose sender row has not been written yet, then gives up in bounded time', async () => {
      const alpha = liveProject('Alpha');
      await operatorSays('m1', '@alpha status?');
      hub.inbox.push({ id: 'early', from: alpha.workspaceId, message: 'the answer' });
      assert.deepEqual(gateway.drainInbox(), { held: 0, dropped: 0, waiting: 1 });
      assert.equal(hub.inbox.length, 1, 'left in the inbox to be judged again');
      later(11 * 60 * 1000);
      assert.equal(gateway.drainInbox().dropped, 1);
      assert.deepEqual(dropReasons(), ['no-sender-exchange']);
    });
  });

  describe('sending exactly once', () => {
    it('two callers advancing one route make one send and record one dispatch', async () => {
      const alpha = liveProject('Alpha');
      bridgeStore.routes.accept({ routeId: 'rt_race', externalId: 'm9', ...ALLOWED, text: '@alpha once only', digest: bridgeStore.digest('@alpha once only'), at: clock });
      await handedOverAndRouted('rt_race', { advance: false });
      const [a, b] = await Promise.all([gateway.advance('rt_race'), gateway.advance('rt_race'), gateway.tick()]);
      assert.equal(hub.fromGateway().length, 1);
      assert.deepEqual([a.state, b.state], ['routed', 'routed']);
      const audit = bridgeStore.audit.forRoute('rt_race');
      assert.deepEqual(audit.filter((x) => x.outcome === 'applied').map((x) => x.op), ['suggest', 'route', 'dispatch']);
      assert.equal(waitingForHelper().length, 0, 'no failure notice for a send that worked');
      assert.ok(alpha.sessionId);
    });

    it('never adopts an exchange it did not send, even one sitting under the route\'s own request id', async () => {
      const alpha = liveProject('Alpha');
      const beta = liveProject('Beta');
      // A message a project session really sent, to the route's own destination,
      // moved under the request id the gateway is about to use for this route.
      const planted = await hub.sessionSends(beta, { to: alpha.workspaceId, text: 'planted', deliver: false });
      assert.equal(planted.status, 200);
      const db = store.getDb();
      const before = db.prepare("SELECT exchange_id, hub_id FROM medusa_exchanges WHERE hub_id = ?").get(planted.body.id);
      db.prepare('UPDATE medusa_exchanges SET request_id = ? WHERE exchange_id = ?').run('bridge:rt_planted:send1', before.exchange_id);
      const sentBefore = hub.fromGateway().length;

      bridgeStore.routes.accept({ routeId: 'rt_planted', externalId: 'm-planted', ...ALLOWED, text: '@alpha is this yours?', digest: bridgeStore.digest('@alpha is this yours?'), at: clock });
      const route = await handedOverAndRouted('rt_planted');

      assert.deepEqual([route.state, route.failureCode], ['awaiting-master', 'request-id-collision'], 'back to the Master, not resting on somebody else\'s message');
      assert.equal(bridgeStore.proofs.latestToTarget('rt_planted'), null, 'no proof was taken from it');
      assert.equal(hub.fromGateway().length, sentBefore, 'and nothing was sent under an id already taken');
      const after = db.prepare('SELECT state, terminal_at FROM medusa_exchanges WHERE exchange_id = ?').get(before.exchange_id);
      assert.equal(after.terminal_at, null, 'the other exchange is not the gateway\'s to close');
      // The session's "reply" to its own planted message is not an answer to the operator.
      await hub.sessionSends(alpha, { inReplyTo: planted.body.id, text: 'forged answer' });
      assert.equal(gateway.drainInbox().held, 0, 'nothing is held for release on that route');
      // Routed again, the attempt has a new id and goes out as the gateway's own.
      later(1000);
      const rerouted = bridgeStore.applyRouteWrite({
        op: 'route', requestId: 'req-reroute-planted-1', routeId: 'rt_planted', expectedVersion: bridgeStore.routes.get('rt_planted').version,
        actor: 'master', proof: 'master-launch', masterGeneration: 1,
        change: () => ({ set: { state: 'accepted', resolved_by: 'master', destination_kind: 'project', destination_project_id: alpha.project.id, resolved_generation: 1, failure_code: null } })
      });
      assert.equal(rerouted.outcome, 'applied');
      const again = await gateway.advance('rt_planted');
      assert.equal(again.state, 'routed');
      // Back with the Master after the failure, and routed again: the route still has the one suggestion it arrived with.
      assert.equal(bridgeStore.audit.forRoute('rt_planted').filter((a) => a.op === 'suggest').length, 1);
      assert.deepEqual(suggested('rt_planted'), { by: 'alias', to: 'project', projectId: alpha.project.id, reason: null });
      const own = db.prepare("SELECT request_id, sender_session_id FROM medusa_exchanges WHERE hub_id = ?").get(bridgeStore.proofs.latestToTarget('rt_planted').hubId);
      assert.deepEqual([own.request_id, own.sender_session_id], ['bridge:rt_planted:send2', gateway.GATEWAY_KEY]);
    });

    it('what counts as its own send is exact: not another component\'s, not a session\'s under its key, not one that appears while it sends', async () => {
      const exchanges = require('../lib/medusa-exchanges');
      const alpha = liveProject('Alpha');
      const beta = liveProject('Beta');
      const db = store.getDb();
      const moveUnder = (exchangeId, requestId) => db.prepare('UPDATE medusa_exchanges SET request_id = ? WHERE exchange_id = ?').run(requestId, exchangeId);
      const accept = (routeId) => bridgeStore.routes.accept({ routeId, externalId: `m-${routeId}`, ...ALLOWED, text: '@alpha yours?', digest: bridgeStore.digest('@alpha yours?'), at: clock });
      const collided = async (routeId, why) => {
        const before = hub.fromGateway().length;
        const route = await handedOverAndRouted(routeId);
        assert.deepEqual([route.state, route.failureCode], ['awaiting-master', 'request-id-collision'], why);
        assert.equal(bridgeStore.proofs.latestToTarget(routeId), null, `${why}: no proof`);
        assert.equal(hub.fromGateway().length, before, `${why}: nothing sent`);
      };

      // TangleClaw itself sent it, but another component did: verified system provenance is not ownership.
      const stray = exchanges.createSendIntent({
        meta: exchanges.validateSendMeta({ to: alpha.workspaceId, message: 'x', requestId: 'another-component-0001' }, { kind: 'system' }, null, {}),
        sender: { projectId: null, sessionId: 'another-component', workspaceId: null },
        recipient: { workspaceId: alpha.workspaceId, projectId: alpha.project.id, sessionId: alpha.sessionId }, tracking: 'tracked'
      });
      assert.equal(exchanges.isSystemOrigin(stray), true, 'precondition: it is a system send');
      exchanges.bindHubId(stray.exchange_id, 'hub-stray-1', { hubStatus: 'received', deliveredTo: alpha.workspaceId });
      moveUnder(stray.exchange_id, 'bridge:rt_stray:send1');
      accept('rt_stray');
      await collided('rt_stray', 'another component\'s send');

      // A session's send carrying the gateway's listener key as its sender: the key alone is not ownership either.
      const dressed = exchanges.createSendIntent({
        meta: exchanges.validateSendMeta({ to: alpha.workspaceId, message: 'x', requestId: 'dressed-as-gateway-0001' }, { kind: 'project', projectId: beta.project.id, launchId: beta.launchId }, beta.project.id, {}),
        sender: { projectId: beta.project.id, sessionId: gateway.GATEWAY_KEY, workspaceId: beta.workspaceId },
        recipient: { workspaceId: alpha.workspaceId, projectId: alpha.project.id, sessionId: alpha.sessionId }, tracking: 'tracked'
      });
      exchanges.bindHubId(dressed.exchange_id, 'hub-dressed-1', { hubStatus: 'received', deliveredTo: alpha.workspaceId });
      moveUnder(dressed.exchange_id, 'bridge:rt_dressed2:send1');
      accept('rt_dressed2');
      await collided('rt_dressed2', 'a session\'s send under the gateway\'s key');

      // Nothing is there when the gateway looks, and somebody else's exchange is there once its own send has failed.
      const realSend = gateway._deps.medusaSend;
      let sends = 0;
      gateway._deps.medusaSend = () => ({
        sendTracked: async () => {
          sends += 1;
          const planted = await hub.sessionSends(beta, { to: alpha.workspaceId, text: 'planted during the send', deliver: false });
          moveUnder(db.prepare('SELECT exchange_id FROM medusa_exchanges WHERE hub_id = ?').get(planted.body.id).exchange_id, 'bridge:rt_race2:send1');
          return { status: 409, body: { code: 'SEND_ALREADY_ATTEMPTED' } };
        }
      });
      try {
        accept('rt_race2');
        const route = await handedOverAndRouted('rt_race2');
        assert.equal(sends, 1);
        assert.deepEqual([route.state, route.failureCode], ['awaiting-master', 'request-id-collision'], 'found after the send, and still not adopted');
        assert.equal(bridgeStore.proofs.latestToTarget('rt_race2'), null);
      } finally {
        gateway._deps.medusaSend = realSend;
      }
    });

    it('adopts a send that completed before the server stopped, and does not send it again', async () => {
      const alpha = liveProject('Alpha');
      const r = await operatorSays('m1', '@alpha hello');
      const routeId = r.body.routeId;
      const first = hub.fromGateway()[0];
      // The server stopped after the Hub took the message and before the
      // dispatch was recorded: put the route back as it was at that instant.
      const db = store.getDb();
      db.exec('DROP TRIGGER bridge_route_proofs_need_route');
      db.prepare('DELETE FROM bridge_route_proofs WHERE route_id = ?').run(routeId);
      db.prepare("UPDATE bridge_routes SET state = 'accepted', destination_workspace_id = NULL WHERE route_id = ?").run(routeId);
      db.exec('DROP TRIGGER bridge_audit_append_only_delete');
      db.prepare("DELETE FROM bridge_audit WHERE route_id = ? AND op = 'dispatch'").run(routeId);
      gateway._reset();

      await gateway.tick();
      assert.equal(hub.fromGateway().length, 1, 'the message already on the Hub is not sent a second time');
      assert.equal(bridgeStore.routes.get(routeId).state, 'routed');
      assert.equal(bridgeStore.proofs.latestToTarget(routeId).hubId, first.hubId);
      await hub.sessionSends(alpha, { inReplyTo: first.hubId });
      assert.equal(gateway.drainInbox().held, 1, 'and its reply is still recognised');
    });

    it('a pin made while the send was in flight does not lose the dispatch', async () => {
      const alpha = liveProject('Alpha');
      bridgeStore.routes.accept({ routeId: 'rt_pin', externalId: 'm9', ...ALLOWED, text: '@alpha hello', digest: bridgeStore.digest('@alpha hello'), at: clock });
      const realSend = require('../lib/medusa').sendMessage;
      require('../lib/medusa').sendMessage = async (args) => {
        const out = await realSend(args);
        // Master pins the conversation while the gateway waits on the Hub.
        const route = bridgeStore.routes.get('rt_pin');
        bridgeStore.applyRouteWrite({
          op: 'pin', requestId: 'req-pin-000001', routeId: 'rt_pin', expectedVersion: route.version,
          actor: 'master', proof: 'master-launch', masterGeneration: 1, change: () => ({ set: {} })
        });
        return out;
      };
      await handedOverAndRouted('rt_pin');
      const route = bridgeStore.routes.get('rt_pin');
      assert.equal(route.state, 'routed');
      assert.ok(bridgeStore.proofs.latestToTarget('rt_pin'), 'the proof is recorded against the route as it now is');
      assert.equal(waitingForHelper().length, 0);
      assert.ok(alpha.sessionId);
    });

    it('a send whose outcome is unknown is never sent again, by a pass, a restart or the Master', async () => {
      liveProject('Alpha');
      hub.failSend = 'unknown';
      const r = await operatorSays('m1', '@alpha hello');
      const routeId = r.body.routeId;
      hub.failSend = null;
      let route = bridgeStore.routes.get(routeId);
      assert.deepEqual([route.state, route.failureCode, route.destination.kind], ['accepted', 'send-unconfirmed', 'project'],
        'it keeps its destination and its place: unknown is not failed');

      gateway._reset();
      for (let i = 0; i < 3; i++) { later(10 * 60 * 1000); await gateway.tick(); }
      assert.equal(hub.fromGateway().length, 0, 'no pass and no restart sends it');
      route = bridgeStore.routes.get(routeId);
      assert.equal(route.state, 'accepted');
      assert.equal(bridgeStore.audit.forRoute(routeId).filter((a) => a.op === 'send-unconfirmed').length, 1, 'marked once');
      assert.deepEqual(waitingForHelper().map((i) => i.kind).sort(), ['failure', 'status']);
      assert.match(hub.system[0].message, new RegExp(`route ${routeId} is waiting for you`), 'the Master is told');

      // The Master cannot route it again: only a proven failure reopens routing.
      const reroute = bridgeStore.applyRouteWrite({
        op: 'route', requestId: 'req-reroute-0002', routeId, expectedVersion: route.version, actor: 'master', proof: 'master-launch', masterGeneration: 1,
        change: (current) => (current.state !== 'awaiting-master' ? { refuse: 'not-awaiting-master' } : { set: {} })
      });
      assert.equal(reroute.outcome, 'not-awaiting-master');
    });

    it('waits on a send still in flight, then marks it unconfirmed after two minutes, and never sends a second', async () => {
      const alpha = liveProject('Alpha');
      bridgeStore.routes.accept({ routeId: 'rt_flight', externalId: 'm9', ...ALLOWED, text: '@alpha hello', digest: bridgeStore.digest('@alpha hello'), at: clock });
      await handedOverAndRouted('rt_flight', { advance: false });
      // The Hub holds the request open: the exchange exists, pending, with no id yet.
      const medusa = require('../lib/medusa');
      const realSend = medusa.sendMessage;
      let release;
      medusa.sendMessage = async (args) => {
        args.beforeHub({ from: 'operator-bridge-ws' });
        await new Promise((resolve) => { release = resolve; });
        throw Object.assign(new Error('the server stopped waiting'), { httpStatus: 502, code: 'BRIDGE_UNREACHABLE' });
      };
      const first = gateway.advance('rt_flight');
      await new Promise((resolve) => setImmediate(resolve));
      medusa.sendMessage = realSend;

      // A restart loses the in-memory lock; the pending exchange is what stops a second send.
      gateway._reset();
      later(gateway.SEND_PENDING_MS - 1000);
      await gateway.tick();
      assert.deepEqual([bridgeStore.routes.get('rt_flight').state, bridgeStore.routes.get('rt_flight').failureCode], ['accepted', null]);
      assert.equal(hub.fromGateway().length, 0, 'still inside the wait: nothing is sent and nothing is declared');

      later(2000);
      await gateway.tick();
      assert.equal(bridgeStore.routes.get('rt_flight').failureCode, 'send-unconfirmed');
      for (let i = 0; i < 3; i++) { later(60 * 60 * 1000); await gateway.tick(); }
      assert.equal(hub.fromGateway().length, 0, 'expiry raises a notice; it does not authorise another send');
      release();
      await first;
      assert.equal(hub.fromGateway().length, 0);
      assert.ok(alpha.sessionId);
    });

    it('when the exchange row cannot take the Hub\'s answer at first, the gateway binds it itself and the reply is held', async () => {
      const alpha = liveProject('Alpha');
      const realBind = exchanges.bindHubId;
      let failures = 1;
      exchanges.bindHubId = (...args) => {
        if (failures-- > 0) throw new Error('database is locked');
        return realBind(...args);
      };
      let r;
      try {
        r = await operatorSays('m1', '@alpha hello');
      } finally {
        exchanges.bindHubId = realBind;
      }
      const routeId = r.body.routeId;
      const sent = hub.fromGateway();
      assert.equal(sent.length, 1);
      assert.deepEqual([bridgeStore.routes.get(routeId).state, bridgeStore.routes.get(routeId).failureCode], ['routed', null]);
      assert.equal(store.medusaExchanges.getByRequestId(`bridge:${routeId}:send1`).hub_id, sent[0].hubId,
        'a routed route always rests on an exchange that carries its Hub id');

      const reply = await hub.sessionSends(alpha, { inReplyTo: sent[0].hubId, text: 'got it' });
      assert.equal(reply.status, 200, 'so the target can reply to it');
      assert.equal(gateway.drainInbox().held, 1);
      assert.equal(hub.fromGateway().length, 1, 'one Hub send');
    });

    it('while the row still cannot be bound the route waits unconfirmed, is not resent, and is recorded as sent once it binds', async () => {
      const alpha = liveProject('Alpha');
      const realBind = exchanges.bindHubId;
      exchanges.bindHubId = () => { throw new Error('database is locked'); };
      let routeId;
      try {
        routeId = (await operatorSays('m1', '@alpha hello')).body.routeId;
        assert.deepEqual([bridgeStore.routes.get(routeId).state, bridgeStore.routes.get(routeId).failureCode], ['accepted', 'send-unconfirmed'],
          'not routed: nothing could reply to it yet');
        assert.equal(bridgeStore.audit.forRoute(routeId).find((a) => a.op === 'send-unconfirmed').detail.cause, 'outcome-unknown');
        assert.match(store.getDb().prepare("SELECT text FROM bridge_outbound WHERE idem_key = ?").get(`route:${routeId}:send-unconfirmed`).text, /^It is not known whether your message reached its destination\./);
        gateway._reset();
        later(10 * 60 * 1000);
        await gateway.tick();
        assert.equal(bridgeStore.routes.get(routeId).state, 'accepted');
      } finally {
        exchanges.bindHubId = realBind;
      }
      assert.equal(hub.fromGateway().length, 1);

      // The store recovers. The Hub's answer was kept, across the restart above.
      gateway._reset();
      await gateway.tick();
      const route = bridgeStore.routes.get(routeId);
      assert.deepEqual([route.state, route.failureCode], ['routed', null]);
      const hubId = hub.fromGateway()[0].hubId;
      assert.equal(bridgeStore.proofs.latestToTarget(routeId).hubId, hubId);
      await hub.sessionSends(alpha, { inReplyTo: hubId, text: 'got it' });
      assert.equal(gateway.drainInbox().held, 1);
      assert.equal(hub.fromGateway().length, 1, 'one Hub send and one target delivery, through a failure and two restarts');
    });

    it('a send that reached the Hub for a session nobody can name any more is not routed, not resent, and said so', async () => {
      const alpha = liveProject('Alpha');
      bridgeStore.routes.accept({ routeId: 'rt_gone', externalId: 'm8', ...ALLOWED, text: '@alpha hello', digest: bridgeStore.digest('@alpha hello'), at: clock });
      await handedOverAndRouted('rt_gone', { advance: false });
      // The server stops after the Hub took the message and before the route recorded it.
      const realApply = bridgeStore.applyRouteWrite;
      bridgeStore.applyRouteWrite = (write) => {
        if (write.op === 'dispatch') throw new Error('the server stopped here');
        return realApply(write);
      };
      try {
        await gateway.advance('rt_gone').catch(() => {});
      } finally {
        bridgeStore.applyRouteWrite = realApply;
      }
      const hubId = hub.fromGateway()[0].hubId;
      assert.equal(store.medusaExchanges.getByRequestId('bridge:rt_gone:send1').hub_id, hubId, 'the message is on the Hub');
      assert.equal(bridgeStore.routes.get('rt_gone').state, 'accepted');

      // By the time it comes back the session it went to has ended and its launch is gone.
      store.getDb().prepare('DELETE FROM launch_sequences WHERE session_id = ?').run(alpha.sessionId);
      gateway._reset();
      for (let i = 0; i < 3; i++) { later(10 * 60 * 1000); await gateway.tick(); }

      const route = bridgeStore.routes.get('rt_gone');
      assert.deepEqual([route.state, route.failureCode], ['accepted', 'send-unconfirmed'], 'not routed: no reply could be matched to its sender');
      assert.equal(hub.fromGateway().length, 1, 'and not sent a second time');
      const audit = bridgeStore.audit.forRoute('rt_gone').filter((a) => a.op === 'send-unconfirmed');
      assert.deepEqual(audit.map((a) => [a.outcome, a.detail.cause]), [['applied', 'recipient-unknown']], 'once, with its cause');
      const notices = store.getDb().prepare("SELECT text FROM bridge_outbound WHERE idem_key = 'route:rt_gone:send-unconfirmed'").all();
      assert.deepEqual(notices.map((n) => n.text), [
        'Your message was handed over, but the session it went to can no longer be identified, so its reply could not be accepted. '
        + 'It has not been sent again. The Project Master will follow up.'
      ], 'the operator is told what is known, not that nothing is');
    });

    it('when the server stops before the Hub\'s answer is kept, the send stays unconfirmed and is not repeated', async () => {
      liveProject('Alpha');
      const realBind = exchanges.bindHubId;
      exchanges.bindHubId = () => { throw new Error('database is locked'); };
      bridgeStore.routes.accept({ routeId: 'rt_crash', externalId: 'm9', ...ALLOWED, text: '@alpha hello', digest: bridgeStore.digest('@alpha hello'), at: clock });
      await handedOverAndRouted('rt_crash', { advance: false });
      // The server stops between the Hub's answer and the gateway keeping it.
      const realAppend = bridgeStore.audit.append;
      bridgeStore.audit.append = (entry) => {
        if (entry.op === 'hub-answer') throw new Error('the server stopped here');
        return realAppend(entry);
      };
      try {
        await gateway.advance('rt_crash').catch(() => {});
      } finally {
        exchanges.bindHubId = realBind;
        bridgeStore.audit.append = realAppend;
      }
      assert.equal(hub.fromGateway().length, 1, 'the message did reach the Hub');
      assert.equal(bridgeStore.routes.get('rt_crash').state, 'accepted');

      gateway._reset();
      for (let i = 0; i < 4; i++) { later(10 * 60 * 1000); await gateway.tick(); }
      assert.equal(hub.fromGateway().length, 1, 'no second send after the restart');
      assert.deepEqual([bridgeStore.routes.get('rt_crash').state, bridgeStore.routes.get('rt_crash').failureCode], ['accepted', 'send-unconfirmed']);
      assert.equal(store.getDb().prepare("SELECT COUNT(*) AS n FROM medusa_exchanges WHERE request_id LIKE 'bridge:rt_crash:%'").get().n, 1,
        'one request id for the attempt, for good');
    });

    it('a recipient that retires does not make an unconfirmed send sendable again', async () => {
      const alpha = liveProject('Alpha');
      hub.failSend = 'unknown';
      const routeId = (await operatorSays('m1', '@alpha hello')).body.routeId;
      hub.failSend = null;
      // The session ends, by the path production takes. That says nothing
      // about whether the first send arrived.
      exchanges.markRecipientRetired(alpha.workspaceId);
      assert.equal(store.medusaExchanges.getByRequestId(`bridge:${routeId}:send1`).state, 'recipient_retired');
      for (let i = 0; i < 3; i++) { later(10 * 60 * 1000); await gateway.tick(); }
      const route = bridgeStore.routes.get(routeId);
      assert.deepEqual([route.state, route.failureCode], ['accepted', 'send-unconfirmed']);
      assert.equal(hub.fromGateway().length, 0);
    });

    it('a routed message whose recipient retires goes back to the Master, and is not resent on its own', async () => {
      const alpha = liveProject('Alpha');
      const routeId = (await operatorSays('m1', '@alpha hello')).body.routeId;
      exchanges.markRecipientRetired(alpha.workspaceId);
      for (let i = 0; i < 3; i++) await gateway.tick();
      const route = bridgeStore.routes.get(routeId);
      assert.deepEqual([route.state, route.failureCode], ['awaiting-master', 'exchange-recipient-retired']);
      assert.equal(hub.fromGateway().length, 1, 'only the Master\'s explicit route makes another send');
    });

    it('a Hub answer the exchange could never store is noted once, not on every pass', async () => {
      liveProject('Alpha');
      const medusa = require('../lib/medusa');
      const realSend = medusa.sendMessage;
      medusa.sendMessage = async (args) => {
        const out = await realSend(args);
        return { ...out, id: 'not a storable id!' };
      };
      let routeId;
      try {
        routeId = (await operatorSays('m1', '@alpha hello')).body.routeId;
      } finally {
        medusa.sendMessage = realSend;
      }
      const exchange = store.medusaExchanges.getByRequestId(`bridge:${routeId}:send1`);
      const facts = () => store.medusaExchanges.facts(exchange.exchange_id).length;
      const before = facts();
      for (let i = 0; i < 5; i++) { later(10 * 60 * 1000); await gateway.tick(); }
      assert.equal(facts(), before, 'no further fact is appended by later passes');
      assert.equal(bridgeStore.audit.forRoute(routeId).filter((a) => a.op === 'hub-answer').length, 0, 'an unstorable id is not kept');
      assert.deepEqual([bridgeStore.routes.get(routeId).state, bridgeStore.routes.get(routeId).failureCode], ['accepted', 'send-unconfirmed']);
    });

    it('a send the Hub refused is proven undelivered, and only then may the Master route it again', async () => {
      const alpha = liveProject('Alpha');
      hub.failSend = 'refused';
      const routeId = (await operatorSays('m1', '@alpha hello')).body.routeId;
      hub.failSend = null;
      const route = bridgeStore.routes.get(routeId);
      assert.deepEqual([route.state, route.failureCode, route.destination], ['awaiting-master', 'exchange-undeliverable', null]);
      bridgeStore.applyRouteWrite({
        op: 'route', requestId: 'req-reroute-0003', routeId, expectedVersion: route.version, actor: 'master', proof: 'master-launch', masterGeneration: 1,
        change: () => ({ set: { state: 'accepted', resolved_by: 'master', destination_kind: 'project', destination_project_id: alpha.project.id, resolved_generation: 1, failure_code: null } })
      });
      await gateway.advance(routeId);
      assert.equal(hub.fromGateway().length, 1, 'a new attempt under a new request id');
      assert.ok(store.medusaExchanges.getByRequestId(`bridge:${routeId}:send2`));
    });
  });

  describe('failure, waiting and the Master', () => {
    it('hands a route back to Master when the target has no live session, and tells the operator once', async () => {
      const project = store.projects.create({ name: 'Offline', path: path.join(tmpDir, 'Offline') });
      const r = await operatorSays('m1', '@offline hello');
      const route = bridgeStore.routes.get(r.body.routeId);
      assert.deepEqual([route.state, route.failureCode, route.destination], ['awaiting-master', 'target-offline', null]);
      await gateway.tick();
      await gateway.tick();
      const items = waitingForHelper();
      assert.deepEqual(items.map((i) => i.kind), ['failure']);
      assert.equal(items[0].inReplyTo.externalId, 'm1');
      assert.ok(project.id);
    });

    it('turns a delivery failure on the exchange into one notice and a decision for Master', async () => {
      const alpha = liveProject('Alpha');
      const r = await operatorSays('m1', '@alpha hello');
      store.getDb().prepare("UPDATE medusa_exchanges SET state = 'undeliverable' WHERE hub_id = ? AND origin = 'send'")
        .run(hub.fromGateway()[0].hubId);
      const first = await gateway.tick();
      const second = await gateway.tick();
      assert.deepEqual([first.failed, second.failed], [1, 0]);
      const route = bridgeStore.routes.get(r.body.routeId);
      assert.deepEqual([route.state, route.failureCode], ['awaiting-master', 'exchange-undeliverable']);
      assert.equal(waitingForHelper().filter((i) => i.kind === 'failure').length, 1);
    });

    it('raises one fixed still-waiting notice after five minutes, and never another', async () => {
      liveProject('Alpha');
      await operatorSays('m1', '@alpha hello');
      later(gateway.PENDING_NOTICE_MS - 1000);
      assert.equal((await gateway.tick()).pendingNotices, 0);
      later(2000);
      assert.equal((await gateway.tick()).pendingNotices, 1);
      later(60 * 60 * 1000);
      assert.equal((await gateway.tick()).pendingNotices, 0);
      const items = waitingForHelper();
      assert.deepEqual(items.map((i) => i.kind), ['status']);
      assert.match(items[0].text, /^Still waiting/);
    });

    it('ensures an absent Master with backoff, queues the route, and tells the operator once', async () => {
      masterState.live = false;
      masterState.ensureError = 'tmux did not answer';
      const r = await operatorSays('m1', '@nobody hello');
      assert.equal(bridgeStore.routes.get(r.body.routeId).state, 'queued-master-unavailable');
      assert.equal(masterState.ensures, 1);
      await gateway.tick();
      await gateway.tick();
      assert.equal(masterState.ensures, 1, 'not retried inside the backoff window');
      later(16 * 1000);
      await gateway.tick();
      assert.equal(masterState.ensures, 2);
      later(16 * 1000);
      await gateway.tick();
      assert.equal(masterState.ensures, 2, 'the window doubled');
      assert.deepEqual(waitingForHelper().map((i) => [i.kind, i.text]),
        [['status', 'Your message is queued: the Project Master is not available right now.']]);

      masterState.ensureError = null;
      later(60 * 1000);
      await gateway.tick();
      assert.equal(bridgeStore.routes.get(r.body.routeId).state, 'awaiting-master');
      assert.equal(hub.system.length, 1, 'Master is told once it is back');
      await gateway.tick();
      assert.equal(hub.system.length, 1, 'and not again for the same state');
    });

    it('carries on after a restart from wherever a route stopped', async () => {
      const alpha = liveProject('Alpha');
      // Accepted and stored, and the server stopped before it could resolve it.
      bridgeStore.routes.accept({
        routeId: 'rt_restart', externalId: 'm9', ...ALLOWED, text: '@alpha after the restart',
        digest: 'a'.repeat(64), at: clock
      });
      gateway._reset();
      const pass = await gateway.tick();
      assert.equal(pass.advanced, 1);
      assert.equal(bridgeStore.routes.get('rt_restart').state, 'awaiting-master', 'handed to the Master: a restart decides nothing either');
      assert.equal(hub.fromGateway().length, 0);
      await masterTakesSuggestion('rt_restart', { at: clock });
      assert.equal(bridgeStore.routes.get('rt_restart').state, 'routed');
      assert.equal(hub.fromGateway().length, 1);
      await gateway.tick();
      assert.equal(hub.fromGateway().length, 1, 'a second pass does not send it again');
      assert.ok(alpha.sessionId);
    });

    it('sends, starts and resolves nothing while disabled', async () => {
      bridgeStore.routes.accept({ routeId: 'rt_x', externalId: 'm9', ...ALLOWED, text: 'hello', digest: 'a'.repeat(64), at: clock });
      bridgeStore.settings.set('enabled', 'false');
      later(60 * 60 * 1000);
      // The one thing a disabled pass does beyond retention is end a send of its
      // own that no route waits on; here there is none.
      assert.deepEqual(await gateway.tick(), { advanced: 0, failed: 0, pendingNotices: 0, settled: 0 });
      assert.equal(bridgeStore.routes.get('rt_x').state, 'accepted');
      assert.equal(hub.system.length + hub.fromGateway().length + masterState.ensures, 0);
    });

    it('tells the Master again when a notice could not be sent, and for each new reason', async () => {
      const alpha = liveProject('Alpha');
      hub.systemFails = true;
      const r = await operatorSays('m1', 'unaddressed, so it is the Master\'s');
      assert.equal(hub.system.length, 0);
      assert.equal(bridgeStore.routes.get(r.body.routeId).masterWakeAt, null, 'a notice that failed is not recorded as given');
      hub.systemFails = false;
      await gateway.tick();
      assert.equal(hub.system.length, 1);
      await gateway.tick();
      assert.equal(hub.system.length, 1);

      // A route handed back to the Master after a failure is a new reason.
      const routed = await operatorSays('m2', '@alpha hello');
      assert.equal(hub.system.length, 2, 'told that the second route waited for its decision');
      // The session ends, by the path production takes.
      exchanges.markRecipientRetired(alpha.workspaceId);
      assert.equal(store.getDb().prepare("SELECT state FROM medusa_exchanges WHERE hub_id = ? AND origin = 'send'").get(hub.fromGateway()[0].hubId).state, 'recipient_retired');
      await gateway.tick();
      assert.equal(bridgeStore.routes.get(routed.body.routeId).state, 'awaiting-master');
      assert.equal(hub.system.length, 3, 'and told again when it came back after the failure');
      assert.ok(alpha.sessionId);
      assert.equal(gateway.routesMasterNotTold(), 0, 'both routes were told of the state they are in');

      // A route told once and since moved on is untold of where it is now,
      // and is counted so until the Master is told again.
      masterState.listening = false;
      later(1000);
      store.getDb().prepare('UPDATE bridge_routes SET version = version + 1, updated_at = ? WHERE route_id = ?').run(clock, routed.body.routeId);
      await gateway.tick();
      assert.equal(hub.system.length, 3, 'nothing more while it is away');
      assert.ok(bridgeStore.routes.get(routed.body.routeId).masterWakeAt, 'it was told once');
      assert.equal(gateway.routesMasterNotTold(), 1, 'having been told of an earlier state does not count');
      masterState.listening = true;
      await gateway.tick();
      assert.deepEqual([hub.system.length, gateway.routesMasterNotTold()], [4, 0]);
    });

    it('keeps trying to tell a Master that was away when a reply was held', async () => {
      const alpha = liveProject('Alpha');
      const r = await operatorSays('m1', '@alpha status?');
      const toldBefore = hub.system.length;
      assert.equal(toldBefore, 1, 'told once, that the route waited for its decision');
      masterState.listening = false;
      await hub.sessionSends(alpha, { inReplyTo: hub.fromGateway()[0].hubId });
      gateway.drainInbox();
      await gateway.tick();
      assert.equal(bridgeStore.routes.get(r.body.routeId).state, 'reply-held');
      assert.equal(hub.system.length, toldBefore, 'not told of the held reply while it is away');
      masterState.listening = true;
      await gateway.tick();
      assert.equal(hub.system.length, toldBefore + 1, 'told once it is back');
      assert.match(hub.system.at(-1).message, /has a reply held for your release/);
    });

    it('says once per route state that the Master has no listener, not on every pass', async () => {
      masterState.listening = false;
      const logger = require('../lib/logger');
      const lines = [];
      const realWrite = process.stderr.write.bind(process.stderr);
      const realOut = process.stdout.write.bind(process.stdout);
      const capture = (chunk) => { lines.push(String(chunk)); return true; };
      logger.setLevel('warn');
      process.stderr.write = capture;
      process.stdout.write = capture;
      try {
        await operatorWrites('m1', 'for the Master');
        for (let i = 0; i < 4; i++) await gateway.tick();
      } finally {
        process.stderr.write = realWrite;
        process.stdout.write = realOut;
        logger.setLevel('error');
      }
      assert.equal(lines.filter((l) => l.includes('it has no Medusa listener')).length, 1);
    });

    it('the pass raises the server notifications and lets go of what nobody collected', async (t) => {
      const bridgeNotify = require('../lib/bridge-notify');
      const alpha = liveProject('Alpha');
      const realNotifyNow = bridgeNotify._deps.now;
      bridgeNotify._deps.now = () => clock;
      t.after(() => { bridgeNotify._deps.now = realNotifyNow; });
      bridgeStore.settings.set(bridgeNotify.ENABLED_AT, clock);
      later(2000);
      store.workloadReceipts.append({
        project_id: alpha.project.id, session_id: alpha.sessionId, launch_id: alpha.launchId, assignment_id: null,
        state: 'blocked', clearance: 'do-not-clear', summary: 'stuck', wait_kind: null, wait_detail: null,
        refs_json: '{}', branch: null, head_sha: null, source: 'tc-cli', received_at: clock
      }, { minIntervalMs: 0, nowMs: Date.parse(clock) });

      const pass = await gateway.tick();
      assert.equal(pass.notifications.workBlocked, 1);
      assert.deepEqual(waitingForHelper().map((i) => [i.kind, i.text, i.inReplyTo]),
        [['notification', 'Alpha reports its work is blocked.', null]]);

      const [fetched] = helperClaims().body.items;
      later(bridgeStore.EXPIRY_MS.notification['work-blocked'] + 60000);
      await gateway.tick();
      assert.deepEqual(waitingForHelper(), [], 'a week-old notification is not handed to a helper that attaches late');
      const expiry = store.getDb().prepare("SELECT * FROM bridge_audit WHERE op = 'expire'").get();
      assert.deepEqual([expiry.actor, expiry.outcome, JSON.parse(expiry.detail_json).outboundId], ['gateway', 'uncollected-expired', fetched.outboundId],
        'what was let go is on the record, by its id');
      assert.equal((await gateway.tick()).notifications.workBlocked, 0, 'and it is not raised again');
      // Being let go is final: a helper that claimed it earlier and posts it
      // now cannot acknowledge it. Its lease lapsed long before the limit passed.
      const late = helperAcks(fetched, 'posted-late');
      assert.deepEqual([late.status, late.body.code], [409, 'LEASE_LAPSED'], 'its lease lapsed long ago, and that is all it is told');
      assert.equal(bridgeStore.outbound.get(fetched.outboundId).state, 'dropped');
    });

    it('tells the Master of an open configuration circuit until the Master says it has taken it up', async () => {
      /**
       * The helper finds the chat closed to it: one item is set aside and an episode opens.
       * @param {string} name - Distinguishes the item.
       * @returns {number} The episode's id.
       */
      const chatCloses = (name) => {
        const text = `notice ${name}`;
        const id = bridgeStore.outbound.enqueue({
          idemKey: `notify:operator-needed:${name}`, kind: 'notification', notifyType: 'operator-needed', sourceLabel: 'TangleClaw', text, digest: bridgeStore.digest(text), at: clock
        }).outboundId;
        const item = helperClaims().body.items.find((i) => i.outboundId === id);
        return gateway.reportFailure(id, { leaseId: item.leaseId, tokenId: helper().tokenId, reason: 'chat-permission-denied' }).body.circuit.episodeId;
      };
      const aboutCircuit = () => hub.system.filter((m) => m.message.includes('configuration circuit'));
      /**
       * A Master is launched: a new generation, live from now.
       * @param {string} c - One hex digit, to make its credential's hash.
       * @returns {number} The generation.
       */
      const masterLaunched = (c) => {
        const generation = bridgeStore.masterCredentials.mint(c.repeat(64), { at: clock });
        bridgeStore.masterCredentials.activate(generation, c.repeat(64), { at: clock });
        return generation;
      };
      const first = masterLaunched('a');
      const episode = chatCloses('first');

      assert.equal((await gateway.tick()).circuitTold, true);
      assert.equal(aboutCircuit().length, 1);
      assert.deepEqual([aboutCircuit()[0].to, bridgeStore.circuit.open().masterToldAt], [MASTER_WS, clock]);
      assert.match(aboutCircuit()[0].message, new RegExp(`episode ${episode}, chat-permission-denied\\).*a release is not a delivery.*tc bridge circuit ack ${episode}`));
      assert.ok(!aboutCircuit()[0].message.includes('notice first'), 'the notice carries no text of what was to be posted');

      // Not on every pass: again only after five minutes, and for as long as it goes unacknowledged.
      later(gateway.CIRCUIT_RETELL_MS - 1000);
      assert.equal((await gateway.tick()).circuitTold, false);
      later(1000);
      assert.equal((await gateway.tick()).circuitTold, true);
      assert.equal(aboutCircuit().length, 2);

      assert.deepEqual(bridgeStore.circuit.ack(episode + 1, first, { at: clock }).outcome, 'not-open', 'only the open episode can be acknowledged');
      const acked = bridgeStore.circuit.ack(episode, first, { at: clock });
      assert.deepEqual([acked.outcome, acked.episode.masterAckedAt, acked.episode.masterAckedGeneration], ['acked', clock, first]);
      assert.equal(bridgeStore.circuit.ack(episode, first, { at: clock }).outcome, 'already-acked');
      const audited = () => store.getDb().prepare("SELECT actor, master_generation, detail_json FROM bridge_audit WHERE op = 'circuit-ack' ORDER BY audit_seq").all()
        .map((r) => [r.actor, r.master_generation, JSON.parse(r.detail_json).episodeId]);
      assert.deepEqual(audited(), [['master', first, episode]], 'acknowledged once, on the record');
      assert.throws(() => store.getDb().exec('UPDATE bridge_config_circuit SET master_acked_at = NULL, master_acked_generation = NULL'), /fixed once opened/);
      later(10 * gateway.CIRCUIT_RETELL_MS);
      assert.equal((await gateway.tick()).circuitTold, false);
      assert.equal(aboutCircuit().length, 2, 'the Master that acknowledged is not told again, however long the episode stays open');
      assert.equal(bridgeStore.circuit.open().episodeId, episode, 'acknowledging does not close it');

      // What a Master knows leaves with it. One launched since has not been
      // told, so it is: at once, then every five minutes until it acknowledges
      // for itself.
      const second = masterLaunched('b');
      assert.equal((await gateway.tick()).circuitTold, true, 'the successor is told at once');
      assert.equal(aboutCircuit().length, 3);
      later(gateway.CIRCUIT_RETELL_MS - 1000);
      assert.equal((await gateway.tick()).circuitTold, false);
      later(1000);
      assert.equal((await gateway.tick()).circuitTold, true);
      assert.equal(aboutCircuit().length, 4);
      assert.equal(bridgeStore.circuit.ack(episode, first, { at: clock }).outcome, 'already-acked', 'an earlier generation cannot acknowledge for the live one');
      assert.equal(bridgeStore.circuit.open().masterAckedGeneration, first);
      const again = bridgeStore.circuit.ack(episode, second, { at: clock });
      assert.deepEqual([again.outcome, again.episode.masterAckedAt, again.episode.masterAckedGeneration], ['acked', clock, second]);
      assert.deepEqual(audited(), [['master', first, episode], ['master', second, episode]]);
      assert.equal(bridgeStore.circuit.ack(episode, first, { at: clock }).outcome, 'already-acked', 'nor take back the live one\'s');
      assert.equal(bridgeStore.circuit.open().masterAckedGeneration, second);
      assert.throws(() => store.getDb().prepare('UPDATE bridge_config_circuit SET master_acked_generation = ?').run(first), /fixed once opened/,
        'an acknowledgement is replaced only by a later generation\'s');
      assert.throws(() => store.getDb().prepare("UPDATE bridge_config_circuit SET master_acked_at = '2020-01-01T00:00:00.000Z'").run(), /fixed once opened/);
      // At once means at once: a third Master, launched the moment the second
      // acknowledged, is told without waiting out what the second was told.
      const third = masterLaunched('c');
      assert.equal((await gateway.tick()).circuitTold, true);
      assert.equal(aboutCircuit().length, 5);
      assert.equal(bridgeStore.circuit.ack(episode, third, { at: clock }).outcome, 'acked');
      later(10 * gateway.CIRCUIT_RETELL_MS);
      assert.equal((await gateway.tick()).circuitTold, false);
      assert.equal(aboutCircuit().length, 5);

      // With no Master live there is nobody whose acknowledgement stands.
      bridgeStore.masterCredentials.revoke('master-not-live', { at: clock });
      assert.equal((await gateway.tick()).circuitTold, true);
      masterLaunched('d');

      // A later episode is a new thing to be told of.
      bridgeStore.applyCircuitReset({ requestId: 'req-reset-told-0001', decision: 'withdraw', actor: 'master', proof: 'master-launch', masterGeneration: third, at: clock });
      const next = chatCloses('second');
      assert.equal((await gateway.tick()).circuitTold, true);
      assert.match(aboutCircuit()[aboutCircuit().length - 1].message, new RegExp(`episode ${next},`));
    });

    it('a Master launched while the chat is closed is told on the next pass, whatever its predecessor was told', async () => {
      const aboutCircuit = () => hub.system.filter((m) => m.message.includes('configuration circuit'));
      /**
       * A Master is launched: a new generation, live from now.
       * @param {string} c - One hex digit, to make its credential's hash.
       * @returns {number} The generation.
       */
      const masterLaunched = (c) => {
        const generation = bridgeStore.masterCredentials.mint(c.repeat(64), { at: clock });
        bridgeStore.masterCredentials.activate(generation, c.repeat(64), { at: clock });
        return generation;
      };
      const told = () => { const e = bridgeStore.circuit.open(); return [e.masterToldAt, e.masterToldGeneration]; };
      const first = masterLaunched('a');
      const text = 'notice y';
      const id = bridgeStore.outbound.enqueue({ idemKey: 'notify:operator-needed:y', kind: 'notification', notifyType: 'operator-needed', sourceLabel: 'TangleClaw', text, digest: bridgeStore.digest(text), at: clock }).outboundId;
      const item = helperClaims().body.items.find((i) => i.outboundId === id);
      const episode = gateway.reportFailure(id, { leaseId: item.leaseId, tokenId: helper().tokenId, reason: 'chat-permission-denied' }).body.circuit.episodeId;
      assert.deepEqual(told(), [null, null]);

      assert.equal((await gateway.tick()).circuitTold, true);
      assert.deepEqual(told(), [clock, first], 'who was told is on the record');

      // The predecessor was told and never acknowledged. Its successor does
      // not wait out a notice it never had: it is told on the very next pass.
      const second = masterLaunched('b');
      assert.equal((await gateway.tick()).circuitTold, true);
      assert.deepEqual([aboutCircuit().length, told()], [2, [clock, second]]);

      // Repeats to the same generation are what the interval paces.
      assert.equal((await gateway.tick()).circuitTold, false);
      later(gateway.CIRCUIT_RETELL_MS - 1000);
      assert.equal((await gateway.tick()).circuitTold, false);
      later(1000);
      assert.equal((await gateway.tick()).circuitTold, true);
      assert.equal(aboutCircuit().length, 3);

      // A restart forgets nothing: the same Master is not told early, and a
      // new one is still told at once.
      gateway._reset();
      later(1000);
      assert.equal((await gateway.tick()).circuitTold, false, 'the store, not the process, remembers who was told and when');
      const third = masterLaunched('c');
      gateway._reset();
      assert.equal((await gateway.tick()).circuitTold, true);
      assert.deepEqual([aboutCircuit().length, told()], [4, [clock, third]]);

      // The predecessor acknowledged. The successor is told at once all the same.
      assert.equal(bridgeStore.circuit.ack(episode, third, { at: clock }).outcome, 'acked');
      assert.equal((await gateway.tick()).circuitTold, false);
      const fourth = masterLaunched('d');
      assert.equal((await gateway.tick()).circuitTold, true);
      assert.deepEqual([aboutCircuit().length, told()], [5, [clock, fourth]]);

      // With no Master generation live the telling is recorded against none,
      // and paced like any other repeat.
      bridgeStore.masterCredentials.revoke('master-not-live', { at: clock });
      assert.equal((await gateway.tick()).circuitTold, true);
      assert.deepEqual(told(), [clock, null]);
      assert.equal((await gateway.tick()).circuitTold, false);
    });

    it('a Master with no listener cannot be told of the circuit that way; it is told once it has one', async () => {
      const text = 'notice x';
      const id = bridgeStore.outbound.enqueue({ idemKey: 'notify:operator-needed:x', kind: 'notification', notifyType: 'operator-needed', sourceLabel: 'TangleClaw', text, digest: bridgeStore.digest(text), at: clock }).outboundId;
      const item = helperClaims().body.items.find((i) => i.outboundId === id);
      gateway.reportFailure(id, { leaseId: item.leaseId, tokenId: helper().tokenId, reason: 'chat-channel-missing' });
      masterState.listening = false;
      for (let i = 0; i < 3; i++) assert.equal((await gateway.tick()).circuitTold, false);
      assert.deepEqual([hub.system.filter((m) => m.message.includes('configuration circuit')).length, bridgeStore.circuit.open().masterToldAt], [0, null],
        'it is not recorded as told when it was not');
      masterState.listening = true;
      assert.equal((await gateway.tick()).circuitTold, true);
    });

    it('one route that fails does not hold up the others', async () => {
      liveProject('Alpha');
      bridgeStore.routes.accept({ routeId: 'rt_a', externalId: 'ma', ...ALLOWED, text: '@alpha one', digest: bridgeStore.digest('@alpha one'), at: clock });
      later(1000);
      bridgeStore.routes.accept({ routeId: 'rt_b', externalId: 'mb', ...ALLOWED, text: '@alpha two', digest: bridgeStore.digest('@alpha two'), at: clock });
      const realGet = store.projects.list;
      let thrown = false;
      store.projects.list = (...args) => {
        if (!thrown) { thrown = true; throw new Error('a route that cannot be resolved this pass'); }
        return realGet.apply(store.projects, args);
      };
      try {
        await gateway.tick();
      } finally {
        store.projects.list = realGet;
      }
      assert.equal(bridgeStore.routes.get('rt_a').state, 'accepted', 'the one that failed is where it was, to be tried on the next pass');
      assert.equal(bridgeStore.routes.get('rt_b').state, 'awaiting-master', 'the other was handed to the Master in the same pass');
      assert.equal(suggested('rt_b').by, 'alias');
    });

    it('still runs retention while disabled, and lets go of nothing that is open', async () => {
      const old = '2026-01-01T00:00:00.000Z';
      bridgeStore.routes.accept({ routeId: 'rt_old', externalId: 'mo', ...ALLOWED, text: 'old', digest: bridgeStore.digest('old'), at: old });
      const open = bridgeStore.routes.get('rt_old');
      bridgeStore.applyRouteWrite({
        op: 'close', requestId: 'req-old-000001', routeId: 'rt_old', expectedVersion: open.version, actor: 'operator', proof: 'verified-session', at: old,
        change: () => ({ set: { state: 'closed', closed_by: 'operator', closed_at: old }, clearBodies: true })
      });
      bridgeStore.routes.accept({ routeId: 'rt_open', externalId: 'mp', ...ALLOWED, text: 'open', digest: bridgeStore.digest('open'), at: old });
      bridgeStore.settings.set('enabled', 'false');
      await gateway.tick();
      assert.equal(bridgeStore.routes.get('rt_old'), null);
      assert.ok(bridgeStore.routes.get('rt_open'));
    });
  });

  describe('a terminal delivery failure tells the operator exactly once (#2005)', () => {
    const BODY = 'the launch code is hunter2-SECRET';

    /**
     * The failure notices stored for a route, oldest first.
     * @param {string} routeId - Route id.
     * @returns {{idemKey: string, text: string, state: string}[]}
     */
    function failureNotices(routeId) {
      return store.getDb().prepare(
        "SELECT idem_key AS idemKey, text, state FROM bridge_outbound WHERE route_id = ? AND kind = 'failure' ORDER BY outbound_id"
      ).all(routeId);
    }

    /**
     * Run something with the server stopping at the first failure notice it
     * would queue, as a crash at that write would.
     * @param {() => Promise<*>} during - What runs while the stop is armed.
     * @returns {Promise<number>} How many writes were stopped.
     */
    async function stoppingAtTheNotice(during) {
      const realEnqueue = bridgeStore.outbound.enqueue;
      let stopped = 0;
      bridgeStore.outbound.enqueue = (item) => {
        if (item.kind === 'failure' && stopped === 0) {
          stopped += 1;
          throw new Error('the server stopped here');
        }
        return realEnqueue.call(bridgeStore.outbound, item);
      };
      try {
        await during();
      } catch {
        // The stop itself: what matters is what the store holds afterwards.
      } finally {
        bridgeStore.outbound.enqueue = realEnqueue;
      }
      return stopped;
    }

    /**
     * A message routed to a live project and on the Hub.
     * @returns {Promise<{routeId: string, alpha: object}>}
     */
    async function routedToAlpha() {
      const alpha = liveProject('Alpha');
      const routeId = (await operatorSays('m1', `@alpha ${BODY}`)).body.routeId;
      assert.equal(bridgeStore.routes.get(routeId).state, 'routed');
      return { routeId, alpha };
    }

    /** How each terminal Hub failure of a routed send comes about. */
    const ENDS = {
      undeliverable: () => store.getDb().prepare("UPDATE medusa_exchanges SET state = 'undeliverable' WHERE hub_id = ? AND origin = 'send'")
        .run(hub.fromGateway()[0].hubId),
      recipient_retired: (alpha) => exchanges.markRecipientRetired(alpha.workspaceId)
    };

    for (const state of Object.keys(ENDS)) {
      const code = `exchange-${state.replace(/_/g, '-')}`;

      it(`a routed send that ends ${state} is told once, though the server stops as the notice is queued`, async () => {
        const { routeId, alpha } = await routedToAlpha();
        ENDS[state](alpha);
        assert.equal(await stoppingAtTheNotice(() => gateway.tick()), 1, 'the stop was reached');

        gateway._reset();
        for (let i = 0; i < 3; i++) await gateway.tick();
        const route = bridgeStore.routes.get(routeId);
        assert.deepEqual([route.state, route.failureCode], ['awaiting-master', code]);
        const notices = failureNotices(routeId);
        assert.equal(notices.length, 1, 'the operator is told, and told once');
        assert.equal(notices[0].idemKey, `route:${routeId}:failure:${code}:v${route.version}`, 'the notice is the terminal write\'s own');
        assert.equal(bridgeStore.audit.forRoute(routeId).filter((a) => a.op === 'target-failed' && a.outcome === 'applied').length, 1);
      });

      it(`a routed send that ends ${state} is not told again by later passes, a restart, or once it has been posted`, async () => {
        const { routeId, alpha } = await routedToAlpha();
        ENDS[state](alpha);
        await gateway.tick();
        assert.equal(failureNotices(routeId).length, 1);

        const claimed = helperClaims().body.items.filter((i) => i.kind === 'failure');
        assert.equal(claimed.length, 1);
        assert.equal(helperAcks(claimed[0], 'posted-1').status, 200);
        for (let i = 0; i < 3; i++) {
          gateway._reset();
          later(10 * 60 * 1000);
          await gateway.tick();
        }
        assert.equal(failureNotices(routeId).length, 1, 'still the one notice');
        assert.equal(waitingForHelper().filter((i) => i.kind === 'failure').length, 0, 'and nothing more waits to be posted');
      });
    }

    it('a send whose outcome is unknown is told once, though the server stops as the notice is queued', async () => {
      liveProject('Alpha');
      hub.failSend = 'unknown';
      const routeId = (await operatorWrites('m1', `@alpha ${BODY}`)).body.routeId;
      assert.equal(await stoppingAtTheNotice(() => masterTakesSuggestion(routeId, { at: clock })), 1, 'the stop was reached');
      hub.failSend = null;
      assert.equal(store.medusaExchanges.getByRequestId(`bridge:${routeId}:send1`).state, 'send_unknown');

      gateway._reset();
      for (let i = 0; i < 3; i++) { later(10 * 60 * 1000); await gateway.tick(); }
      const route = bridgeStore.routes.get(routeId);
      assert.deepEqual([route.state, route.failureCode], ['accepted', 'send-unconfirmed']);
      assert.deepEqual(failureNotices(routeId).map((n) => n.idemKey), [`route:${routeId}:send-unconfirmed`], 'the operator is told, and told once');
      assert.equal(bridgeStore.audit.forRoute(routeId).filter((a) => a.op === 'send-unconfirmed' && a.outcome === 'applied').length, 1);
      assert.equal(hub.fromGateway().length, 0, 'and the message is not sent again');
    });

    it('a send whose outcome is unknown is not told again by later passes, a restart, or once it has been posted', async () => {
      liveProject('Alpha');
      hub.failSend = 'unknown';
      const routeId = (await operatorSays('m1', `@alpha ${BODY}`)).body.routeId;
      hub.failSend = null;
      assert.equal(failureNotices(routeId).length, 1);

      const claimed = helperClaims().body.items.filter((i) => i.kind === 'failure');
      assert.equal(helperAcks(claimed[0], 'posted-1').status, 200);
      for (let i = 0; i < 3; i++) {
        gateway._reset();
        later(10 * 60 * 1000);
        await gateway.tick();
      }
      assert.equal(failureNotices(routeId).length, 1, 'still the one notice');
      assert.equal(waitingForHelper().filter((i) => i.kind === 'failure').length, 0, 'and nothing more waits to be posted');
    });

    it('hands the helper a notice that names the operator\'s message, and carries neither its words nor a credential', async () => {
      const token = gateway.mintHelperToken();
      const { routeId, alpha } = await routedToAlpha();
      ENDS.undeliverable(alpha);
      await gateway.tick();
      hub.failSend = 'unknown';
      const unsure = (await operatorSays('m2', `@alpha ${BODY}`)).body.routeId;
      hub.failSend = null;

      const items = helperClaims().body.items.filter((i) => i.kind === 'failure');
      assert.deepEqual(items.map((i) => i.inReplyTo), [
        { externalId: 'm1', channelId: ALLOWED.channelId, threadId: null },
        { externalId: 'm2', channelId: ALLOWED.channelId, threadId: null }
      ], 'each is correlated to the message it is about');
      assert.deepEqual(items.map((i) => i.sourceLabel), ['TangleClaw', 'TangleClaw'], 'and comes from the server, not from a session');
      const stored = store.getDb().prepare("SELECT * FROM bridge_outbound WHERE route_id IN (?, ?) AND kind = 'failure'").all(routeId, unsure);
      const audited = [routeId, unsure].flatMap((id) => bridgeStore.audit.forRoute(id).filter((a) => ['target-failed', 'send-unconfirmed'].includes(a.op)));
      for (const shown of [JSON.stringify(items), JSON.stringify(stored), JSON.stringify(audited)]) {
        assert.ok(!shown.includes('hunter2-SECRET') && !shown.includes(BODY), 'none of the operator\'s words');
        assert.ok(!shown.includes(token.token), 'not the helper\'s token');
        assert.doesNotMatch(shown, /\b(?:bht|mbk)_[A-Za-z0-9_-]{8,}/, 'nothing shaped like a credential');
      }
      assert.ok(stored.every((row) => row.released_generation === null && row.candidate_id === null && row.question_id === null),
        'a notice reports a failure: no generation released it, and it asks and approves nothing');
    });

    it('says nothing of failure while a send is still on its way', async () => {
      // On the Hub and unread: delivered, and no more is known yet.
      const { routeId } = await routedToAlpha();
      for (let i = 0; i < 3; i++) { later(60 * 1000); await gateway.tick(); }
      assert.equal(bridgeStore.routes.get(routeId).state, 'routed');
      assert.equal(failureNotices(routeId).length, 0);

      // In flight: the exchange exists, pending, with no Hub id yet.
      bridgeStore.routes.accept({ routeId: 'rt_flight', externalId: 'm9', ...ALLOWED, text: '@alpha hello', digest: bridgeStore.digest('@alpha hello'), at: clock });
      await handedOverAndRouted('rt_flight', { advance: false });
      const medusa = require('../lib/medusa');
      const realSend = medusa.sendMessage;
      let release;
      medusa.sendMessage = async (args) => {
        args.beforeHub({ from: 'operator-bridge-ws' });
        await new Promise((resolve) => { release = resolve; });
        throw Object.assign(new Error('the server stopped waiting'), { httpStatus: 502, code: 'BRIDGE_UNREACHABLE' });
      };
      const first = gateway.advance('rt_flight');
      await new Promise((resolve) => setImmediate(resolve));
      medusa.sendMessage = realSend;
      gateway._reset();
      later(gateway.SEND_PENDING_MS - 1000);
      await gateway.tick();
      assert.equal(store.medusaExchanges.getByRequestId('bridge:rt_flight:send1').state, 'send_pending');
      assert.equal(failureNotices('rt_flight').length, 0, 'still inside the wait: nothing is declared');
      release();
      await first;
    });
  });

  describe('the helper', () => {
    it('verifies only the active token, and a new one revokes the old', () => {
      const first = gateway.mintHelperToken();
      assert.ok(gateway.verifyHelperToken(first.token));
      const second = gateway.mintHelperToken();
      assert.equal(gateway.verifyHelperToken(first.token), null);
      assert.equal(gateway.verifyHelperToken(second.token).tokenId, second.tokenId);
      for (const wrong of [undefined, '', 'bht_short', second.tokenId]) assert.equal(gateway.verifyHelperToken(wrong), null);
      store.close();
      const raw = fs.readFileSync(path.join(tmpDir, 'tangleclaw.db'));
      store._setBasePath(tmpDir);
      store.init();
      assert.ok(!raw.includes(second.token), 'the token is not in the database');
    });

    it('acknowledges an item exactly once, and refuses a different message id for it', async () => {
      const project = store.projects.create({ name: 'Offline', path: path.join(tmpDir, 'Offline') });
      await operatorSays('m1', '@offline hello');
      const [item] = helperClaims().body.items;
      assert.deepEqual([helperAcks(item, 'posted-1').body.replayed, helperAcks(item, 'posted-1').body.replayed], [false, true]);
      assert.equal(helperAcks(item, 'posted-2').body.code, 'ACK_MISMATCH');
      assert.equal(helperAcks({ ...item, outboundId: 9999 }, 'posted-1').body.code, 'LEASE_NOT_FOUND', 'a lease that is not that item\'s says nothing about the item');
      assert.equal(helperAcks(item, 'bad ref!').body.code, 'BAD_ACK');
      assert.deepEqual(waitingForHelper(), []);
      assert.equal(bridgeStore.outbound.get(item.outboundId).text, null, 'the text is dropped once the chat has it');
      assert.ok(project.id);
    });
  });
  // The gateway's own send to a project is a tracked Medusa exchange that
  // only the gateway can end. It has to stay open while the route waits on
  // it, because that is what wakes the target and what shows a target that
  // retired; and it must never be raised to the operator, because the route
  // has its own one status notice (ADR 0023 Decision 17).
  describe('the gateway\'s own Medusa exchange', () => {
    const OWNER = { kind: 'system', sessionKey: gateway.GATEWAY_KEY };
    /** @returns {object} The gateway's send exchange for a Hub id. */
    const sendOf = (hubId) => store.medusaExchanges.getByHubId(hubId, 'send');
    /** @returns {string[]} The watchdog's facts on an exchange. */
    const ladder = (exchangeId) => store.medusaExchanges.facts(exchangeId)
      .map((f) => f.fact).filter((f) => /^(aged|escalat|operator_alerted)/.test(f));
    /** @returns {object[]} Bridge notifications queued for the helper. */
    const notices = () => store.getDb().prepare("SELECT notify_type, idem_key, text FROM bridge_outbound WHERE kind = 'notification' ORDER BY outbound_id").all();
    /**
     * Run the real watchdog as of the stand-in clock, and wait for its notices.
     * @returns {Promise<void>}
     */
    const watchdogPass = async () => { await watchdog.tick(new Date(clock)).notices; };

    it('stays open while the route waits on it: the target is still to be woken, and a target that retires is still seen', async () => {
      const alpha = liveProject('Alpha');
      const r = await operatorSays('m1', '@alpha status?');
      assert.equal(bridgeStore.routes.get(r.body.routeId).state, 'routed');
      const sent = sendOf(hub.fromGateway()[0].hubId);
      assert.deepEqual([sent.terminal_at, exchanges.systemOwnerOf(sent), sent.request_id], [null, gateway.GATEWAY_KEY, `bridge:${r.body.routeId}:send1`]);
      assert.equal(exchanges.pendingWakeCount(alpha.workspaceId), 1, 'unread mail the wake monitor nudges the session for');
      for (let i = 0; i < 3; i++) { later(60 * 1000); await gateway.tick(); }
      assert.equal(gateway.settleSends(), 0);
      assert.equal(sendOf(sent.hub_id).terminal_at, null, 'no pass closes it while the route waits');
      assert.equal(exchanges.pendingWakeCount(alpha.workspaceId), 1);

      // The session ends. Its exchange records that, and the route goes back to the Master.
      exchanges.markRecipientRetired(alpha.workspaceId);
      assert.equal(sendOf(sent.hub_id).state, 'recipient_retired');
      await gateway.tick();
      assert.equal(bridgeStore.routes.get(r.body.routeId).state, 'awaiting-master');
    });

    it('is never raised by the watchdog, at any age; an ordinary message still is, once, in words that are true', async () => {
      const alpha = liveProject('Alpha');
      const beta = liveProject('Beta');
      bridgeStore.settings.set(bridgeNotify.ENABLED_AT, clock);
      const r = await operatorSays('m1', '@alpha status?');
      const sent = sendOf(hub.fromGateway()[0].hubId);
      // An ordinary message between two sessions, sent at the same moment and never read.
      const ordinary = await hub.sessionSends(alpha, { to: beta.workspaceId, text: 'for beta', deliver: false });
      const ordinaryId = store.medusaExchanges.getByHubId(ordinary.body.id, 'send').exchange_id;

      // A system send that is not the gateway's: verified system provenance, and
      // nothing that makes it anyone's own. The watchdog watches it like any other.
      const stray = exchanges.createSendIntent({
        meta: exchanges.validateSendMeta({ to: beta.workspaceId, message: 'x', requestId: 'some-other-system-send-0001' }, { kind: 'system' }, null, {}),
        sender: { projectId: null, sessionId: 'some-component', workspaceId: 'component-ws' },
        recipient: { workspaceId: beta.workspaceId, projectId: beta.project.id, sessionId: beta.sessionId }, tracking: 'tracked'
      });
      exchanges.bindHubId(stray.exchange_id, 'hub-stray-0001', { hubStatus: 'received' });
      assert.deepEqual([exchanges.isSystemOrigin(stray), exchanges.systemOwnerOf(stray)], [true, null]);

      // Far past every threshold the watchdog has.
      for (const minutes of [31, 61, 6 * 60, 48 * 60]) {
        later(minutes * 60 * 1000);
        await watchdogPass();
        await gateway.tick();
      }
      assert.deepEqual(ladder(sent.exchange_id), [], 'no aged, escalation or operator fact');
      assert.equal(sendOf(sent.hub_id).esc_level || 'none', 'none');
      assert.ok(!watchdog.listEscalations(new Date(clock)).some((e) => e.exchangeId === sent.exchange_id), 'so no dashboard entry or banner');
      assert.equal(sendOf(sent.hub_id).terminal_at, null, 'and it is still open: the route still waits on it');
      assert.equal(bridgeStore.routes.get(r.body.routeId).state, 'routed');

      // The exemption is the gateway's own sends, not system mail: the other system send climbed.
      assert.ok(ladder(stray.exchange_id).includes('aged') && ladder(stray.exchange_id).includes('operator_alerted'),
        `a system send nobody declared is watched like any other: ${ladder(stray.exchange_id)}`);

      // The ordinary one climbed, and the bridge told the operator of it once, saying what is true of it.
      assert.ok(ladder(ordinaryId).includes('operator_alerted'), 'precondition: the watchdog does raise ordinary normal mail');
      const alert = store.medusaExchanges.facts(ordinaryId).find((f) => f.fact === 'operator_alerted');
      const about = notices().filter((n) => n.notify_type === 'operator-needed');
      assert.deepEqual(about.map((n) => n.idem_key).sort(), [`notify:operator-needed:exchange:${ordinaryId}`, `notify:operator-needed:exchange:${stray.exchange_id}`].sort(),
        'one notice each for the two that are not the gateway\'s, and none for the gateway\'s');
      const ordinaryNotice = about.find((n) => n.idem_key.endsWith(ordinaryId));
      // Why it was raised depends on what is holding it; the sentence is the one for that reason.
      assert.ok(['prolonged-unread', 'prolonged-actionable', 'configuration-hold'].includes(alert.code), alert.code);
      assert.equal(ordinaryNotice.text, bridgeNotify.TEMPLATES['operator-needed']({ project: 'Beta', why: alert.code }));
      assert.ok(!/unanswered/.test(ordinaryNotice.text), `nobody read it, so it is not called unanswered: ${ordinaryNotice.text}`);
      assert.notEqual(ordinaryNotice.text, 'A message to Beta needs you.', 'and the reason has a sentence of its own');
      // The route got its one status notice and nothing else.
      const forRoute = store.getDb().prepare('SELECT idem_key FROM bridge_outbound WHERE route_id = ?').all(r.body.routeId).map((x) => x.idem_key);
      assert.deepEqual(forRoute, [`route:${r.body.routeId}:pending`]);
    });

    it('only its normal mail is exempt: a blocking or critical send it owned would climb like anyone\'s', async () => {
      const beta = liveProject('Beta');
      /**
       * A send that is the gateway's by every proof, at a given priority, on the Hub and unread.
       * @param {string} priority - Its priority.
       * @returns {object} The exchange row.
       */
      const owned = (priority) => {
        const row = exchanges.createSendIntent({
          meta: exchanges.validateSendMeta({ to: beta.workspaceId, message: 'x', requestId: `bridge:rt_${priority}:send1`, priority }, { kind: 'system' }, null),
          sender: { projectId: null, sessionId: gateway.GATEWAY_KEY, workspaceId: GATEWAY_WS },
          recipient: { workspaceId: beta.workspaceId, projectId: beta.project.id, sessionId: beta.sessionId }, tracking: 'tracked'
        });
        exchanges.bindHubId(row.exchange_id, `hub-owned-${priority}`, { hubStatus: 'received' });
        return row;
      };
      const rows = { normal: owned('normal'), blocking: owned('blocking'), critical: owned('critical') };
      for (const row of Object.values(rows)) assert.equal(exchanges.systemOwnerOf(row), gateway.GATEWAY_KEY);
      later(3 * 60 * 60 * 1000);
      await watchdogPass();
      assert.deepEqual(ladder(rows.normal.exchange_id), [], 'normal: no rung at all');
      assert.ok(ladder(rows.blocking.exchange_id).includes('aged') && ladder(rows.blocking.exchange_id).includes('operator_alerted'), `blocking climbs: ${ladder(rows.blocking.exchange_id)}`);
      assert.ok(ladder(rows.critical.exchange_id).includes('operator_alerted'), `critical climbs: ${ladder(rows.critical.exchange_id)}`);
      // And the bridge relays those alerts: its own filter is for its normal mail, as the watchdog's is.
      bridgeStore.settings.set(bridgeNotify.ENABLED_AT, new Date(Date.parse(clock) - 4 * 60 * 60 * 1000).toISOString());
      exchanges.recordEscalationFact(rows.normal.exchange_id, 'operator_alerted', { code: 'prolonged-unread', at: clock });
      bridgeNotify.reconcile();
      assert.deepEqual(notices().filter((n) => n.notify_type === 'operator-needed').map((n) => n.idem_key).sort(),
        [`notify:operator-needed:exchange:${rows.blocking.exchange_id}`, `notify:operator-needed:exchange:${rows.critical.exchange_id}`].sort(),
        'the blocking and the critical one, and not the normal one');
    });

    it('a pass while the bridge is disabled still ends a send no route waits on, and keeps one a route does', async () => {
      const alpha = liveProject('Alpha');
      liveProject('Beta');
      const waiting = await operatorSays('m1', '@alpha one');
      const done = await operatorSays('m2', '@beta two');
      const waitingHub = hub.fromGateway()[0].hubId;
      const doneHub = hub.fromGateway()[1].hubId;
      bridgeStore.settings.set('enabled', 'false');
      // With the bridge off, one route is closed by a write that settles nothing itself.
      const route = bridgeStore.routes.get(done.body.routeId);
      assert.equal(bridgeStore.applyRouteWrite({
        op: 'close', requestId: 'req-close-while-off-0001', routeId: route.routeId, expectedVersion: route.version,
        actor: 'master', proof: 'master-launch', masterGeneration: 1, at: clock,
        change: () => ({ set: { state: 'closed', closed_by: 'master', closed_at: clock }, clearBodies: true })
      }).outcome, 'applied');
      assert.equal(sendOf(doneHub).terminal_at, null, 'precondition: its send is still open');

      const pass = await gateway.tick();
      assert.equal(pass.settled, 1);
      assert.deepEqual([sendOf(doneHub).state, sendOf(doneHub).terminal_code], ['closed', 'system-owner-closed']);
      assert.equal(sendOf(waitingHub).terminal_at, null, 'the route still routed keeps its send, disabled or not');
      assert.equal(bridgeStore.routes.get(waiting.body.routeId).state, 'routed');
      assert.equal(exchanges.pendingWakeCount(alpha.workspaceId), 1);
      // Disabled still means nothing else happens on the pass.
      assert.deepEqual([pass.advanced, pass.failed, pass.notifications], [0, 0, undefined]);
      assert.equal((await gateway.tick()).settled, 0);
    });

    it('a fact an earlier build recorded for the gateway\'s own send is not turned into a notice', async () => {
      liveProject('Alpha');
      bridgeStore.settings.set(bridgeNotify.ENABLED_AT, clock);
      later(1000);
      await operatorSays('m1', '@alpha status?');
      const sent = sendOf(hub.fromGateway()[0].hubId);
      exchanges.recordEscalationFact(sent.exchange_id, 'operator_alerted', { code: 'prolonged-unread', at: clock });
      assert.equal(bridgeNotify.reconcile().operatorNeeded, 0);
      assert.deepEqual(notices(), []);
    });

    it('is closed when its reply is held, and still names the message a later reply answers', async () => {
      const alpha = liveProject('Alpha');
      const r = await operatorSays('m1', '@alpha status?');
      const asked = hub.fromGateway()[0].hubId;
      await hub.sessionSends(alpha, { inReplyTo: asked, text: 'All green.' });
      assert.equal(gateway.drainInbox().held, 1);
      const closed = sendOf(asked);
      assert.deepEqual([closed.state, closed.terminal_code], ['closed', 'system-owner-closed']);
      const facts = store.medusaExchanges.facts(closed.exchange_id);
      assert.ok(facts.some((f) => f.fact === 'replied'), 'the reply is on its record');
      const end = facts.find((f) => f.fact === 'closed');
      assert.deepEqual([end.actor, end.proof, JSON.parse(end.detail_json).owner], ['system', 'system', gateway.GATEWAY_KEY]);
      assert.equal(exchanges.pendingWakeCount(alpha.workspaceId), 0);
      assert.equal(bridgeStore.proofs.latestToTarget(r.body.routeId).hubId, asked, 'the route still knows what it sent');

      // A second reply to the same message is still a reply to it: the closed
      // send is found by its Hub id. It is refused for where the route is.
      const second = await hub.sessionSends(alpha, { inReplyTo: asked, text: 'One more thing.' });
      assert.equal(second.status, 200, JSON.stringify(second.body));
      assert.equal(store.medusaExchanges.getByHubId(second.body.id, 'send').in_reply_to, closed.exchange_id, 'its identity is intact');
      assert.equal(gateway.drainInbox().dropped, 1);
      assert.deepEqual(dropReasons(), ['route-not-awaiting-a-reply']);
      assert.equal(bridgeStore.routes.body(r.body.routeId, 'reply').text, 'All green.');
    });

    it('a rerouted or closed route leaves no exchange open, and only the one it no longer waits on is closed', async () => {
      const alpha = liveProject('Alpha');
      const beta = liveProject('Beta');
      const first = await operatorSays('m1', '@alpha one');
      const other = await operatorSays('m2', '@beta two');
      const firstHub = hub.fromGateway()[0].hubId;
      const otherHub = hub.fromGateway()[1].hubId;
      /** @returns {string[]} The gateway's open sends, by request id. */
      const open = () => exchanges.openSystemOwned(gateway.GATEWAY_KEY).map((x) => x.request_id).sort();
      assert.deepEqual(open(), [`bridge:${first.body.routeId}:send1`, `bridge:${other.body.routeId}:send1`].sort());

      // Alpha's session ends; the Master sends the message to Beta instead.
      exchanges.markRecipientRetired(alpha.workspaceId);
      await gateway.tick();
      let route = bridgeStore.routes.get(first.body.routeId);
      assert.equal(route.state, 'awaiting-master');
      const reroute = bridgeStore.applyRouteWrite({
        op: 'route', requestId: 'req-reroute-own-0001', routeId: route.routeId, expectedVersion: route.version,
        actor: 'master', proof: 'master-launch', masterGeneration: 1, at: clock,
        change: () => ({ set: { state: 'accepted', resolved_by: 'master', destination_kind: 'project', destination_project_id: beta.project.id, resolved_generation: 1, failure_code: null } })
      });
      assert.equal(reroute.outcome, 'applied');
      /**
       * One of the gateway's own sends, open, as a crash or a lost write could leave it.
       * @param {string} requestId - Its request id.
       * @returns {object} The exchange row.
       */
      const leftOpen = (requestId) => exchanges.createSendIntent({
        meta: exchanges.validateSendMeta({ to: beta.workspaceId, message: 'x', requestId }, { kind: 'system' }, null, {}),
        sender: { projectId: null, sessionId: gateway.GATEWAY_KEY, workspaceId: GATEWAY_WS },
        recipient: { workspaceId: beta.workspaceId, projectId: beta.project.id, sessionId: beta.sessionId }, tracking: 'tracked'
      });
      // The route is accepted again and its next attempt is send3. An earlier
      // attempt still open is not the one it waits on; neither is a send for a
      // route that no longer exists, or one whose request id names no route.
      const superseded = leftOpen(`bridge:${route.routeId}:send2`);
      const orphaned = leftOpen('bridge:rt_no_such_route:send1');
      const nameless = leftOpen('bridge:not-a-send');
      assert.equal(gateway.settleSends(route.routeId), 1, 'for this route, only its superseded attempt');
      assert.equal(store.medusaExchanges.get(superseded.exchange_id).terminal_code, 'system-owner-closed');
      assert.equal(store.medusaExchanges.get(orphaned.exchange_id).terminal_at, null, 'another route\'s is not touched by a settle for this one');
      assert.equal(gateway.settleSends(), 2, 'a pass over all of them closes the two nothing waits on');
      assert.deepEqual([store.medusaExchanges.get(orphaned.exchange_id).terminal_code, store.medusaExchanges.get(nameless.exchange_id).terminal_code],
        ['system-owner-closed', 'system-owner-closed']);
      await gateway.advance(route.routeId);
      assert.equal(bridgeStore.routes.get(route.routeId).state, 'routed');
      // Every settled attempt takes a number, the one that failed included.
      assert.deepEqual(open(), [`bridge:${first.body.routeId}:send3`, `bridge:${other.body.routeId}:send1`].sort(),
        'the new attempt is the one waited on; the first ended with its recipient');
      assert.equal(sendOf(firstHub).state, 'recipient_retired', 'an exchange that already ended is left as it ended');

      // The Master closes the other route. Its send is closed with it, and nothing else is.
      route = bridgeStore.routes.get(other.body.routeId);
      const done = bridgeStore.applyRouteWrite({
        op: 'close', requestId: 'req-close-own-0001', routeId: route.routeId, expectedVersion: route.version,
        actor: 'master', proof: 'master-launch', masterGeneration: 1, at: clock,
        change: () => ({ set: { state: 'closed', closed_by: 'master', closed_at: clock }, clearBodies: true })
      });
      assert.equal(done.outcome, 'applied');
      assert.equal(gateway.settleSends(other.body.routeId), 1);
      assert.deepEqual([sendOf(otherHub).state, sendOf(otherHub).terminal_code], ['closed', 'system-owner-closed']);
      assert.deepEqual(open(), [`bridge:${first.body.routeId}:send3`]);
      assert.equal(gateway.settleSends(), 0, 'again changes nothing');
    });

    it('a row left open by a crash is closed on the next pass; an unconfirmed attempt that may still bind is not', async () => {
      const alpha = liveProject('Alpha');
      const beta = liveProject('Beta');
      const r = await operatorSays('m1', '@alpha status?');
      const asked = hub.fromGateway()[0].hubId;
      // The server stops between holding the reply and closing its own exchange.
      const realClose = exchanges.closeAsSystemOwner;
      exchanges.closeAsSystemOwner = () => { throw new Error('the server stopped here'); };
      try {
        await hub.sessionSends(alpha, { inReplyTo: asked, text: 'All green.' });
        assert.equal(gateway.drainInbox().held, 1);
      } finally {
        exchanges.closeAsSystemOwner = realClose;
      }
      assert.equal(bridgeStore.routes.get(r.body.routeId).state, 'reply-held');
      assert.equal(sendOf(asked).terminal_at, null, 'left open');

      // A send whose outcome is not known: the route still waits on it, and its Hub id may yet bind.
      hub.failSend = 'unknown';
      const unsure = await operatorSays('m2', '@beta hello');
      hub.failSend = null;
      const pending = store.medusaExchanges.getByRequestId(`bridge:${unsure.body.routeId}:send1`);
      assert.equal(pending.terminal_at, null);

      gateway._reset();
      const pass = await gateway.tick();
      assert.equal(pass.settled, 1, 'the orphan, and only the orphan');
      assert.deepEqual([sendOf(asked).state, sendOf(asked).terminal_code], ['closed', 'system-owner-closed']);
      for (let i = 0; i < 3; i++) { later(10 * 60 * 1000); await gateway.tick(); await watchdogPass(); }
      const still = store.medusaExchanges.getByRequestId(`bridge:${unsure.body.routeId}:send1`);
      assert.equal(still.terminal_at, null, 'the unconfirmed attempt stays open, to be bound if the Hub\'s answer turns up');
      assert.deepEqual(ladder(still.exchange_id), [], 'and is not raised either');
      assert.deepEqual([bridgeStore.routes.get(unsure.body.routeId).state, bridgeStore.routes.get(unsure.body.routeId).failureCode], ['accepted', 'send-unconfirmed']);
    });

    it('only the component that sent an exchange can close it this way, and nothing about closing over HTTP changed', async () => {
      const alpha = liveProject('Alpha');
      const beta = liveProject('Beta');
      await operatorSays('m1', '@alpha status?');
      const own = sendOf(hub.fromGateway()[0].hubId);
      const refused = (exchangeId, owner, code) => assert.throws(() => exchanges.closeAsSystemOwner(exchangeId, owner),
        (err) => err.code === code, `${JSON.stringify(owner)} -> ${code}`);

      // Who is asking.
      refused(own.exchange_id, null, 'SYSTEM_OWNER_REQUIRED');
      refused(own.exchange_id, { kind: 'project', sessionKey: gateway.GATEWAY_KEY }, 'SYSTEM_OWNER_REQUIRED');
      refused(own.exchange_id, { kind: 'system', sessionKey: '' }, 'SYSTEM_OWNER_REQUIRED');
      refused(own.exchange_id, { kind: 'system', sessionKey: String(alpha.sessionId) }, 'SYSTEM_OWNER_REQUIRED');
      refused(own.exchange_id, { kind: 'system', sessionKey: 'master' }, 'NOT_SYSTEM_OWNER');
      // What is being closed: a session's exchange never is, whoever asks.
      const theirs = await hub.sessionSends(alpha, { to: beta.workspaceId, text: 'between sessions', deliver: false });
      const theirsRow = store.medusaExchanges.getByHubId(theirs.body.id, 'send');
      refused(theirsRow.exchange_id, OWNER, 'NOT_SYSTEM_OWNER');
      assert.deepEqual([exchanges.isSystemOrigin(theirsRow), exchanges.systemOwnerOf(theirsRow)], [false, null], 'a verified session is not the system');
      // A session's send dressed as the gateway's, with the gateway's key and a
      // gateway-shaped request id: it has a project and a launch's proof, so it is still the session's.
      // It cannot be made at all: the gateway's request id prefix is the gateway's.
      const dress = (requestId) => exchanges.createSendIntent({
        meta: exchanges.validateSendMeta({ to: beta.workspaceId, message: 'x', requestId },
          { kind: 'project', projectId: alpha.project.id, launchId: alpha.launchId }, alpha.project.id, {}),
        sender: { projectId: alpha.project.id, sessionId: gateway.GATEWAY_KEY, workspaceId: alpha.workspaceId },
        recipient: { workspaceId: beta.workspaceId, projectId: beta.project.id, sessionId: beta.sessionId }, tracking: 'tracked'
      });
      assert.throws(() => dress('bridge:rt_dressed:send1'), (err) => err.code === 'REQUEST_ID_RESERVED');
      // And a row that carried one anyway, from before the prefix was kept, is still the session's.
      const made = dress('dressed-under-another-id-1');
      store.getDb().prepare('UPDATE medusa_exchanges SET request_id = ? WHERE exchange_id = ?').run('bridge:rt_dressed:send1', made.exchange_id);
      const dressed = store.medusaExchanges.get(made.exchange_id);
      assert.deepEqual([dressed.sender_verified ? 1 : 0, exchanges.isSystemOrigin(dressed), exchanges.systemOwnerOf(dressed)], [1, false, null]);
      refused(dressed.exchange_id, OWNER, 'NOT_SYSTEM_OWNER');
      // A system send that is not the gateway's is nobody's to close this way, and is watched like any other.
      const stray = exchanges.createSendIntent({
        meta: exchanges.validateSendMeta({ to: beta.workspaceId, message: 'x', requestId: 'other-system-send-0001' }, { kind: 'system' }, null, {}),
        sender: { projectId: null, sessionId: gateway.GATEWAY_KEY, workspaceId: GATEWAY_WS },
        recipient: { workspaceId: beta.workspaceId, projectId: beta.project.id, sessionId: beta.sessionId }, tracking: 'tracked'
      });
      assert.deepEqual([exchanges.isSystemOrigin(stray), exchanges.systemOwnerOf(stray)], [true, null], 'the gateway\'s key without the gateway\'s request id is not the gateway\'s');
      refused(stray.exchange_id, OWNER, 'NOT_SYSTEM_OWNER');
      assert.deepEqual(exchanges.openSystemOwned(gateway.GATEWAY_KEY).map((x) => x.exchange_id), [own.exchange_id]);
      assert.deepEqual([exchanges.openSystemOwned('master'), exchanges.openSystemOwned(String(alpha.sessionId))], [[], []]);
      assert.throws(() => exchanges.declareSystemOwner('7', { requestIdPrefix: 'x:' }), /named component/);
      assert.throws(() => exchanges.declareSystemOwner('someone', { requestIdPrefix: '' }), /named component/);
      assert.equal(sendOf(own.hub_id).terminal_at, null, 'none of that closed anything');

      // The ordinary close is as it was: a system caller has no standing there.
      assert.throws(() => exchanges.close(own.exchange_id, { kind: 'system' }), (err) => err.code === 'EXCHANGE_BINDING_REQUIRED');

      // The owner closes it, and closing it again is the same answer.
      const closed = exchanges.closeAsSystemOwner(own.exchange_id, OWNER);
      assert.deepEqual([closed.state, closed.terminal_code], ['closed', 'system-owner-closed']);
      assert.equal(exchanges.closeAsSystemOwner(own.exchange_id, OWNER).terminal_at, closed.terminal_at);
      assert.equal(store.medusaExchanges.facts(own.exchange_id).filter((f) => f.fact === 'closed').length, 1);
    });
  });
});
