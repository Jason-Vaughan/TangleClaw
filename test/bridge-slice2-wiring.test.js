'use strict';

// Car 63-C (#2842, #2843, Charter A500 v1.0, Architect Ruling A500-W1C-R1):
// wires the already-shipped Slice 1 primitives (lib/bridge-confirmation.js,
// lib/bridge-reach.js, lib/bridge-channels.js, lib/bridge-awareness.js) into
// live HTTP routes, plus the pure render/parse helpers a confirmation-card
// flow needs. The dashboard/step-up modal (`public/bridge-step-up.js`) and
// the batch-opt-out/notification-policy/channel-inventory UI
// (`public/bridge-settings-ui.js`) are standalone, lift-and-run tested
// modules -- neither is mounted into any page yet (Architect Ruling's own
// scope line defers that, and any server.js/lib/tc-verbs.js singleton
// wiring, to #2884).

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const crypto = require('node:crypto');
const store = require('../lib/store');
const bridgeStore = require('../lib/bridge-store');
const bridgeConfirmation = require('../lib/bridge-confirmation');
const bridgeChannels = require('../lib/bridge-channels');
const outbound = require('../lib/bridge-helper/outbound');
const inbound = require('../lib/bridge-helper/inbound');
const bridgeApi = require('../lib/bridge-api');
const gateway = require('../lib/bridge-gateway');
const vm = require('node:vm');
const { makeDocument, withIdParsingInnerHTML } = require('./_mini-dom');

/**
 * Load `public/bridge-step-up.js` and `public/bridge-settings-ui.js` into
 * one vm sandbox and hand back their published globals -- the same
 * `vm.createContext`/`runInContext` lift `test/_api-helper-globals.js`
 * already uses for `api-helper.js`, inlined here since these two files are
 * this car's own, not that shared loader's.
 * @returns {object}
 */
function loadBridgeUiGlobals() {
  const files = ['bridge-step-up.js', 'bridge-settings-ui.js'];
  const sandbox = { console, setTimeout, clearTimeout };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  for (const file of files) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', file), 'utf8'), sandbox);
  }
  return sandbox;
}

const START = Date.parse('2026-11-05T08:00:00.000Z');
const MINUTE = 60 * 1000;

const realNow = bridgeConfirmation._internal.now;
let tmpDir = null;

/** @param {number} [ms] @returns {void} */
function clockAt(ms = 0) {
  bridgeConfirmation._internal.now = () => new Date(START + ms).toISOString();
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-bridge-slice2-'));
  store._setBasePath(tmpDir);
  store.init();
  clockAt(0);
});

afterEach(() => {
  bridgeConfirmation._internal.now = realNow;
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const BASE = {
  operatorId: 'op-1', guildId: 'guild-1', channelId: 'chan-1',
  targetRef: 'PR#123', digestSha: 'a'.repeat(64), version: 1, ttlMs: 10 * MINUTE
};

/**
 * Create a confirmation, with overrides, same baseline every test shares.
 * @param {object} [overrides]
 * @returns {object}
 */
function create(overrides = {}) {
  return bridgeConfirmation.createActionConfirmation({ ...BASE, actionKind: 'merge', ...overrides });
}

describe('bridge-confirmation: step-up approval (#2842 Slice 2, Chunk 1)', () => {
  describe('listPendingConfirmations', () => {
    it('lists only pending step-up tier confirmations, never confirmation-card ones', () => {
      create({ actionKind: 'merge' }); // confirmation-card tier
      const stepUp = create({ actionKind: 'rule-change' }); // step-up tier
      const pending = bridgeConfirmation.listPendingConfirmations();
      assert.equal(pending.length, 1);
      assert.equal(pending[0].confirmationId, stepUp.confirmation.confirmationId);
      assert.equal(pending[0].actionKind, 'rule-change');
    });

    it('scopes to one operator when asked', () => {
      create({ actionKind: 'rule-change', operatorId: 'op-1' });
      create({ actionKind: 'rule-change', operatorId: 'op-2' });
      const pending = bridgeConfirmation.listPendingConfirmations({ operatorId: 'op-2' });
      assert.equal(pending.length, 1);
      assert.equal(pending[0].operatorId, 'op-2');
    });

    it('excludes an expired row, applying the lazy transition on read', () => {
      create({ actionKind: 'data-deletion', ttlMs: MINUTE });
      clockAt(2 * MINUTE);
      assert.deepEqual(bridgeConfirmation.listPendingConfirmations(), []);
    });

    it('excludes a consumed row', () => {
      const { confirmation } = create({ actionKind: 'credential-change' });
      bridgeConfirmation.approveStepUpConfirmation(confirmation.confirmationId, {
        operatorId: BASE.operatorId, guildId: BASE.guildId, channelId: BASE.channelId,
        actionKind: 'credential-change', targetRef: BASE.targetRef, digestSha: BASE.digestSha, version: BASE.version
      });
      assert.deepEqual(bridgeConfirmation.listPendingConfirmations(), []);
    });
  });

  describe('approveStepUpConfirmation', () => {
    it('approves a bound, pending step-up confirmation and consumes it', () => {
      const { confirmation } = create({ actionKind: 'permission-change' });
      const result = bridgeConfirmation.approveStepUpConfirmation(confirmation.confirmationId, {
        operatorId: BASE.operatorId, guildId: BASE.guildId, channelId: BASE.channelId,
        actionKind: 'permission-change', targetRef: BASE.targetRef, digestSha: BASE.digestSha, version: BASE.version
      });
      assert.equal(result.ok, true);
      assert.equal(result.confirmation.state, 'consumed');
    });

    it('refuses a confirmation-card-tier item -- approve is step-up only, never a substitute for the nonce', () => {
      const { confirmation } = create({ actionKind: 'merge' });
      const result = bridgeConfirmation.approveStepUpConfirmation(confirmation.confirmationId, {
        operatorId: BASE.operatorId, guildId: BASE.guildId, channelId: BASE.channelId,
        actionKind: 'merge', targetRef: BASE.targetRef, digestSha: BASE.digestSha, version: BASE.version
      });
      assert.deepEqual([result.ok, result.code], [false, 'CONFIRMATION_INVALID']);
    });

    it('rejects an unknown confirmationId', () => {
      const result = bridgeConfirmation.approveStepUpConfirmation('conf_nope', { operatorId: 'x' });
      assert.deepEqual([result.ok, result.code], [false, 'CONFIRMATION_INVALID']);
    });

    it('rejects a second approval of the same confirmation -- single-use, same as verify', () => {
      const { confirmation } = create({ actionKind: 'rule-change' });
      const presented = {
        operatorId: BASE.operatorId, guildId: BASE.guildId, channelId: BASE.channelId,
        actionKind: 'rule-change', targetRef: BASE.targetRef, digestSha: BASE.digestSha, version: BASE.version
      };
      bridgeConfirmation.approveStepUpConfirmation(confirmation.confirmationId, presented);
      const replay = bridgeConfirmation.approveStepUpConfirmation(confirmation.confirmationId, presented);
      assert.deepEqual([replay.ok, replay.code], [false, 'CONFIRMATION_REPLAYED']);
    });

    it('rejects an approval bound to the wrong operator (scope mismatch)', () => {
      const { confirmation } = create({ actionKind: 'rule-change' });
      const result = bridgeConfirmation.approveStepUpConfirmation(confirmation.confirmationId, {
        operatorId: 'someone-else', guildId: BASE.guildId, channelId: BASE.channelId,
        actionKind: 'rule-change', targetRef: BASE.targetRef, digestSha: BASE.digestSha, version: BASE.version
      });
      assert.deepEqual([result.ok, result.code], [false, 'CONFIRMATION_SCOPE_MISMATCH']);
    });

    it('rejects an approval against a different target (digest mismatch)', () => {
      const { confirmation } = create({ actionKind: 'rule-change' });
      const result = bridgeConfirmation.approveStepUpConfirmation(confirmation.confirmationId, {
        operatorId: BASE.operatorId, guildId: BASE.guildId, channelId: BASE.channelId,
        actionKind: 'rule-change', targetRef: 'some-other-target', digestSha: BASE.digestSha, version: BASE.version
      });
      assert.deepEqual([result.ok, result.code], [false, 'CONFIRMATION_DIGEST_MISMATCH']);
    });

    it('rejects approval of an expired confirmation', () => {
      const { confirmation } = create({ actionKind: 'rule-change', ttlMs: MINUTE });
      clockAt(2 * MINUTE);
      const result = bridgeConfirmation.approveStepUpConfirmation(confirmation.confirmationId, {
        operatorId: BASE.operatorId, guildId: BASE.guildId, channelId: BASE.channelId,
        actionKind: 'rule-change', targetRef: BASE.targetRef, digestSha: BASE.digestSha, version: BASE.version
      });
      assert.deepEqual([result.ok, result.code], [false, 'CONFIRMATION_EXPIRED']);
    });
  });

  describe('denyStepUpConfirmation', () => {
    it('denies a pending confirmation, consuming it with a rejected outcome', () => {
      const { confirmation } = create({ actionKind: 'data-deletion' });
      const result = bridgeConfirmation.denyStepUpConfirmation(confirmation.confirmationId, 'operator said no');
      assert.equal(result.ok, true);
      assert.equal(result.confirmation.state, 'consumed');
    });

    it('a denied confirmation can never later be approved -- deny is single-use terminal, same as approve', () => {
      const { confirmation } = create({ actionKind: 'data-deletion' });
      bridgeConfirmation.denyStepUpConfirmation(confirmation.confirmationId);
      const approve = bridgeConfirmation.approveStepUpConfirmation(confirmation.confirmationId, {
        operatorId: BASE.operatorId, guildId: BASE.guildId, channelId: BASE.channelId,
        actionKind: 'data-deletion', targetRef: BASE.targetRef, digestSha: BASE.digestSha, version: BASE.version
      });
      assert.deepEqual([approve.ok, approve.code], [false, 'CONFIRMATION_REPLAYED']);
    });

    it('rejects an unknown confirmationId', () => {
      const result = bridgeConfirmation.denyStepUpConfirmation('conf_nope');
      assert.deepEqual([result.ok, result.code], [false, 'CONFIRMATION_INVALID']);
    });
  });
});

describe('bridge-helper outbound: renderConfirmationCard (#2842 Slice 2, Chunk 2)', () => {
  it('renders the action, target, expiry and reply instructions with the nonce', () => {
    const text = outbound.renderConfirmationCard({
      actionKind: 'merge', targetRef: 'PR#123', expiresAt: '2026-11-05T08:10:00.000Z', nonce: 'deadbeef'
    });
    // `#` and `:` are both in render()'s own escaped character class (the
    // convention this function deliberately reuses), so a target ref or
    // timestamp containing either comes back backslash-escaped.
    assert.match(text, /Action: `merge`/);
    assert.match(text, /Target: `PR\\#123`/);
    assert.match(text, /2026-11-05T08\\:10\\:00\.000Z/);
    assert.match(text, /confirm deadbeef/);
  });

  it('escapes markdown in a target ref, same convention as render()', () => {
    const text = outbound.renderConfirmationCard({
      actionKind: 'merge', targetRef: '*bold* [link](evil)', expiresAt: '2026-11-05T08:10:00.000Z', nonce: 'deadbeef'
    });
    assert.doesNotMatch(text, /Target: `\*bold\* \[link\]\(evil\)`/, 'raw markdown must not survive unescaped');
    assert.match(text, /\\\*bold\\\*/);
  });
});

describe('bridge-helper inbound: parseConfirmationReply (#2842 Slice 2, Chunk 2)', () => {
  const NONCE = 'a'.repeat(64);

  it('parses an exact "confirm <nonce>" reply, case-insensitively', () => {
    assert.equal(inbound.parseConfirmationReply(`confirm ${NONCE}`), NONCE);
    assert.equal(inbound.parseConfirmationReply(`CONFIRM ${NONCE}`), NONCE);
    assert.equal(inbound.parseConfirmationReply(`  confirm ${NONCE}  `), NONCE);
    assert.equal(inbound.parseConfirmationReply(`confirm ${NONCE}.`), NONCE);
  });

  it('refuses ordinary conversation that merely mentions "confirm" -- anchored to the WHOLE message, not a scan', () => {
    assert.equal(inbound.parseConfirmationReply(`can you confirm ${NONCE} is right?`), null);
    assert.equal(inbound.parseConfirmationReply(`confirm ${NONCE} please`), null);
    assert.equal(inbound.parseConfirmationReply('confirm'), null);
    assert.equal(inbound.parseConfirmationReply(`confirm ${'a'.repeat(63)}`), null, 'nonce must be exactly 64 hex chars');
    assert.equal(inbound.parseConfirmationReply(`confirm ${'g'.repeat(64)}`), null, 'hex only');
  });

  it('returns null for non-string input rather than throwing', () => {
    assert.equal(inbound.parseConfirmationReply(null), null);
    assert.equal(inbound.parseConfirmationReply(undefined), null);
  });
});

describe('lib/bridge-api.js routes, called directly via bridgeApi.handle (#2842/#2843 Slice 2, Chunks 3-4)', () => {
  const ALLOWED = { authorId: 'author1', spaceId: 'space1', channelId: 'chan1' };
  /** A signed-in operator, as `server.js` annotates the request (same shape test/api-bridge-gateway.test.js uses). */
  const SIGNED_IN = { tcSession: { username: 'rosie' }, tcGateState: 'guarding', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
  let helperToken;

  beforeEach(() => {
    bridgeStore.settings.set('enabled', 'true');
    bridgeStore.settings.set('allow.author', ALLOWED.authorId);
    bridgeStore.settings.set('allow.space', ALLOWED.spaceId);
    bridgeStore.settings.set('allow.channel', ALLOWED.channelId);
    helperToken = gateway.mintHelperToken().token;
  });

  /** @returns {Promise<{status: number, body: object}>} */
  function asOperator(method, path, { params, query, body } = {}) {
    return bridgeApi.handle(bridgeApi.routeFor(method, path), { req: SIGNED_IN, params: params || {}, query: query || {}, body: body || {} });
  }

  /** @returns {Promise<{status: number, body: object}>} */
  function asHelper(method, path, { params, query, body } = {}) {
    return bridgeApi.handle(bridgeApi.routeFor(method, path), {
      req: { socket: { remoteAddress: '127.0.0.1' } },
      headers: { [bridgeApi.HELPER_TOKEN_HEADER]: helperToken, [bridgeApi.HELPER_NONCE_HEADER]: crypto.randomBytes(16).toString('hex') },
      params: params || {}, query: query || {}, body: body || {}
    });
  }

  describe('#2842: action-confirmation + step-up routes', () => {
    it('classify answers the tier for an ordinary action and a confirmation-card action', async () => {
      const ordinary = await asHelper('POST', '/api/bridge/helper/action-confirmation/classify', { body: { actionType: 'implement' } });
      assert.deepEqual([ordinary.status, ordinary.body.tier], [200, 'ordinary-work']);
      const merge = await asHelper('POST', '/api/bridge/helper/action-confirmation/classify', { body: { actionType: 'merge' } });
      assert.deepEqual([merge.status, merge.body.tier], [200, 'confirmation-card']);
    });

    it('create binds the confirmation to the verified allowlist, never a client-supplied identity', async () => {
      const result = await asHelper('POST', '/api/bridge/helper/action-confirmation/create', {
        body: { actionKind: 'merge', targetRef: 'PR#1', digestSha: 'a'.repeat(64), version: 1,
          // An attempted spoof: this must be IGNORED in favor of the verified allowlist.
          operatorId: 'attacker', guildId: 'attacker-guild', channelId: 'attacker-channel' }
      });
      assert.equal(result.status, 201);
      assert.equal(result.body.confirmation.operatorId, ALLOWED.authorId);
      assert.equal(result.body.confirmation.guildId, ALLOWED.spaceId);
      assert.ok(result.body.confirmation.nonce, 'the nonce is returned once, for the card text');
    });

    it('verify consumes a nonce created through the same route, end to end', async () => {
      const created = await asHelper('POST', '/api/bridge/helper/action-confirmation/create', {
        body: { actionKind: 'release', targetRef: 'v1.2.3', digestSha: 'b'.repeat(64), version: 1 }
      });
      const verified = await asHelper('POST', '/api/bridge/helper/action-confirmation/verify', {
        body: { nonce: created.body.confirmation.nonce, actionKind: 'release', targetRef: 'v1.2.3', digestSha: 'b'.repeat(64), version: 1 }
      });
      assert.equal(verified.status, 200);
      assert.equal(verified.body.confirmation.state, 'consumed');
      const replay = await asHelper('POST', '/api/bridge/helper/action-confirmation/verify', {
        body: { nonce: created.body.confirmation.nonce, actionKind: 'release', targetRef: 'v1.2.3', digestSha: 'b'.repeat(64), version: 1 }
      });
      assert.deepEqual([replay.status, replay.body.code], [409, 'CONFIRMATION_REPLAYED']);
    });

    it('step-up: create (via the helper route) then list/approve from the operator route, end to end', async () => {
      const created = await asHelper('POST', '/api/bridge/helper/action-confirmation/create', {
        body: { actionKind: 'rule-change', targetRef: 'rule#5', digestSha: 'c'.repeat(64), version: 1 }
      });
      const pending = await asOperator('GET', '/api/bridge/operator/step-up/pending');
      assert.equal(pending.status, 200);
      assert.equal(pending.body.pending.length, 1);
      assert.equal(pending.body.pending[0].confirmationId, created.body.confirmation.confirmationId);

      const approved = await asOperator('POST', '/api/bridge/operator/step-up/:confirmationId/approve', {
        params: { confirmationId: created.body.confirmation.confirmationId },
        body: { actionKind: 'rule-change', targetRef: 'rule#5', digestSha: 'c'.repeat(64), version: 1 }
      });
      assert.equal(approved.status, 200);
      assert.equal(approved.body.confirmation.state, 'consumed');
      assert.deepEqual((await asOperator('GET', '/api/bridge/operator/step-up/pending')).body.pending, []);
    });

    it('step-up: deny from the operator route', async () => {
      const created = await asHelper('POST', '/api/bridge/helper/action-confirmation/create', {
        body: { actionKind: 'data-deletion', targetRef: 'row#9', digestSha: 'd'.repeat(64), version: 1 }
      });
      const denied = await asOperator('POST', '/api/bridge/operator/step-up/:confirmationId/deny', {
        params: { confirmationId: created.body.confirmation.confirmationId }, body: { reason: 'not now' }
      });
      assert.equal(denied.status, 200);
      assert.equal(denied.body.confirmation.state, 'consumed');
    });
  });

  describe('#2843: reach batch, narrowing prompt, notification policy, channels, publication grant', () => {
    it('reach batch opts projects out, then back in', async () => {
      const project = store.projects.create({ name: `slice2-reach-${Date.now()}`, path: '/tmp/x' });
      const out = await asOperator('POST', '/api/bridge/operator/reach/batch', { body: { projectIds: [project.id], outOfReach: true } });
      assert.deepEqual([out.status, out.body.outOfReachIds], [200, [project.id]]);
      const back = await asOperator('POST', '/api/bridge/operator/reach/batch', { body: { projectIds: [project.id], outOfReach: false } });
      assert.deepEqual([back.status, back.body.reachableIds], [200, [project.id]]);
    });

    it('reach batch refuses a malformed projectIds', async () => {
      const result = await asOperator('POST', '/api/bridge/operator/reach/batch', { body: { projectIds: 'not-an-array', outOfReach: true } });
      assert.equal(result.status, 400);
    });

    it('the narrowing prompt dismissal is one-time and persists', async () => {
      const before = await asOperator('GET', '/api/bridge/operator/reach/narrowing-prompt');
      assert.equal(before.body.dismissed, false);
      await asOperator('POST', '/api/bridge/operator/reach/narrowing-prompt/dismiss');
      const after = await asOperator('GET', '/api/bridge/operator/reach/narrowing-prompt');
      assert.deepEqual([after.body.shouldPrompt, after.body.dismissed], [false, true]);
    });

    it('notification policy: global set, then read back at both the global and project layers', async () => {
      const set = await asOperator('POST', '/api/bridge/operator/notification-policy/global', { body: { eventKind: 'fleet-idle', enabled: false } });
      assert.deepEqual([set.status, set.body.enabled, set.body.source], [200, false, 'global']);
      const read = await asOperator('GET', '/api/bridge/operator/notification-policy/:eventKind', { params: { eventKind: 'fleet-idle' } });
      assert.deepEqual([read.body.enabled, read.body.source], [false, 'global']);
    });

    it('notification policy: a project override wins over the global default', async () => {
      await asOperator('POST', '/api/bridge/operator/notification-policy/global', { body: { eventKind: 'gateway-down', enabled: true } });
      await asOperator('POST', '/api/bridge/operator/notification-policy/project/:projectId', {
        params: { projectId: '7' }, body: { eventKind: 'gateway-down', enabled: false }
      });
      const read = await asOperator('GET', '/api/bridge/operator/notification-policy/:eventKind', {
        params: { eventKind: 'gateway-down' }, query: { projectId: '7' }
      });
      assert.deepEqual([read.body.enabled, read.body.source], [false, 'project']);
    });

    it('channels: register, list, update, and read it back', async () => {
      const registered = await asOperator('POST', '/api/bridge/operator/channels', {
        body: { channelId: 'watch-1', guildId: 'g1', name: 'general-watch', mode: 'watch-only' }
      });
      assert.equal(registered.status, 201);
      const listed = await asOperator('GET', '/api/bridge/operator/channels');
      assert.equal(listed.body.channels.length, 1);
      const updated = await asOperator('PATCH', '/api/bridge/operator/channels/:channelId', {
        params: { channelId: 'watch-1' }, body: { sendAllowed: true }
      });
      assert.deepEqual([updated.status, updated.body.channel.sendAllowed], [200, true]);
    });

    it('channels: update of an unknown channel is 404', async () => {
      const result = await asOperator('PATCH', '/api/bridge/operator/channels/:channelId', {
        params: { channelId: 'no-such-channel' }, body: { sendAllowed: true }
      });
      assert.equal(result.status, 404);
    });

    it('watched messages: the helper records one, the operator reads it back', async () => {
      bridgeChannels.registerChannel({ channelId: 'watch-2', guildId: 'g1', name: 'forum-watch', mode: 'watch-only' });
      const recorded = await asHelper('POST', '/api/bridge/helper/channels/watched-messages', {
        body: { messageId: 'm1', channelId: 'watch-2', authorLabel: 'someone', sourceLabel: 'Discord', text: 'hello' }
      });
      assert.equal(recorded.status, 201);
      const read = await asOperator('GET', '/api/bridge/operator/channels/:channelId/watched-messages', { params: { channelId: 'watch-2' } });
      assert.equal(read.body.messages.length, 1);
      assert.equal(read.body.messages[0].text, 'hello');
    });

    it('publication grant: create from the operator route, check and consume from the helper routes', async () => {
      bridgeChannels.registerChannel({ channelId: 'post-1', guildId: 'g1', name: 'postable', mode: 'two-way', sendAllowed: true });
      const textSha256 = 'e'.repeat(64);
      const created = await asOperator('POST', '/api/bridge/operator/publication-grant', {
        body: { destinationChannelId: 'post-1', textSha256, operatorRouteId: 'route-1', idempotencyKey: 'idem-1' }
      });
      assert.equal(created.status, 201);
      const checked = await asHelper('POST', '/api/bridge/helper/publication-grant/check', {
        body: { idempotencyKey: 'idem-1', destinationChannelId: 'post-1', textSha256, operatorRouteId: 'route-1' }
      });
      assert.equal(checked.status, 200);
      const consumed = await asHelper('POST', '/api/bridge/helper/publication-grant/consume', {
        body: { idempotencyKey: 'idem-1', destinationChannelId: 'post-1', textSha256, operatorRouteId: 'route-1', outcome: 'posted' }
      });
      assert.deepEqual([consumed.status, consumed.body.grant.state], [200, 'consumed']);
    });
  });
});

describe('public/bridge-step-up.js (#2842 Slice 2, Chunk 5) -- standalone, not yet mounted into any page', () => {
  const G = loadBridgeUiGlobals();

  /** @returns {{doc: object, bar: object}} */
  function mounted(extraDeps) {
    const { doc, ids } = makeDocument(['root']);
    withIdParsingInnerHTML(ids.root, doc);
    const bar = G.tcCreateBridgeStepUp(Object.assign({ doc, rootId: 'root', prefix: 'su', esc: (s) => String(s) }, extraDeps));
    return { doc, bar };
  }

  it('mount renders the static shell', () => {
    const { doc, bar } = mounted({});
    assert.equal(bar.mount(), true);
    assert.ok(doc.getElementById('suStatus'));
    assert.ok(doc.getElementById('suList'));
  });

  it('tcBridgeStepUpItemMarkup renders uniquely-id\'d controls keyed on confirmationId', () => {
    const html = G.tcBridgeStepUpItemMarkup('su', {
      confirmationId: 'conf_abc123', actionKind: 'rule-change', targetRef: 'rule#5', expiresAt: '2026-11-05T09:00:00.000Z'
    }, (s) => String(s));
    assert.match(html, /id="suApprove_conf_abc123"/);
    assert.match(html, /id="suDeny_conf_abc123"/);
    assert.match(html, /id="suDenyReason_conf_abc123"/);
    assert.match(html, /rule-change/);
    assert.match(html, /rule#5/);
  });

  it('load() paints the status line from the pending list', async () => {
    const { doc, bar } = mounted({
      api: async () => ({ pending: [{ confirmationId: 'conf_1', actionKind: 'rule-change', targetRef: 'r1', expiresAt: 'x' }] })
    });
    bar.mount();
    await bar.load();
    assert.equal(doc.getElementById('suStatus').textContent, '1 pending');
  });

  it('load() reports a failed read rather than claiming "Nothing pending"', async () => {
    const { doc, bar } = mounted({ api: Object.assign(async () => null, { lastError: 'read failed' }) });
    bar.mount();
    await bar.load();
    assert.equal(doc.getElementById('suStatus').textContent, 'read failed');
  });

  it('approve() posts to the exact pending item\'s own action fields, then reloads', async () => {
    const calls = [];
    let loadCount = 0;
    const { bar } = mounted({
      api: async () => { loadCount += 1; return { pending: loadCount === 1 ? [{ confirmationId: 'conf_1', actionKind: 'rule-change', targetRef: 'r1', digestSha: 'a'.repeat(64), version: 1, expiresAt: 'x' }] : [] }; },
      apiMutate: async (p, m, b) => { calls.push([p, m, b]); return { ok: true }; }
    });
    bar.mount();
    await bar.load();
    const ok = await bar.approve('conf_1');
    assert.equal(ok, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], '/api/bridge/operator/step-up/conf_1/approve');
    assert.equal(calls[0][2].actionKind, 'rule-change');
    assert.equal(loadCount, 2, 'approve() reloads the list');
  });

  it('approve() of an unknown confirmationId is a no-op', async () => {
    const calls = [];
    const { bar } = mounted({ api: async () => ({ pending: [] }), apiMutate: async (p, m, b) => { calls.push([p, m, b]); return { ok: true }; } });
    bar.mount();
    await bar.load();
    assert.equal(await bar.approve('conf_nope'), false);
    assert.equal(calls.length, 0);
  });

  it('deny() posts the reason, then reloads', async () => {
    const calls = [];
    let loadCount = 0;
    const { bar } = mounted({
      api: async () => { loadCount += 1; return { pending: [] }; },
      apiMutate: async (p, m, b) => { calls.push([p, m, b]); return { ok: true }; }
    });
    bar.mount();
    await bar.load();
    const ok = await bar.deny('conf_2', 'not now');
    assert.equal(ok, true);
    // Field-by-field, not a whole-tuple deepEqual: the body object is built
    // inside the vm-sandboxed public/*.js file (a different realm), which
    // node:assert's deepEqual can misreport as unequal despite identical
    // content -- the same reason test/advisor-control-bar.test.js's own
    // comments document for api-helper.js's sandbox.
    assert.equal(calls[0][0], '/api/bridge/operator/step-up/conf_2/deny');
    assert.equal(calls[0][1], 'POST');
    assert.equal(calls[0][2].reason, 'not now');
    assert.equal(loadCount, 2);
  });
});

describe('public/bridge-settings-ui.js (#2843 Slice 2, Chunk 6) -- standalone, not yet mounted into any page', () => {
  const G = loadBridgeUiGlobals();
  const PROJECTS = [{ id: 1, name: 'alpha' }, { id: 2, name: 'beta' }];

  /** @returns {{doc: object, ui: object}} */
  function mounted(extraDeps) {
    const { doc, ids } = makeDocument(['root']);
    withIdParsingInnerHTML(ids.root, doc);
    const ui = G.tcCreateBridgeSettingsUi(Object.assign(
      { doc, rootId: 'root', prefix: 'bs', esc: (s) => String(s), projects: PROJECTS, eventKinds: ['fleet-idle', 'gateway-down'] },
      extraDeps
    ));
    return { doc, ui };
  }

  it('mount renders every section\'s static shell', () => {
    const { doc, ui } = mounted({});
    assert.equal(ui.mount(), true);
    for (const id of ['ReachStatus', 'NarrowingPrompt', 'ProjectList', 'PolicyStatus', 'PolicyList', 'ChannelsStatus', 'ChannelList', 'NewChannelId']) {
      assert.ok(doc.getElementById(`bs${id}`), `expected #bs${id}`);
    }
  });

  it('tcBridgeReachProjectMarkup and tcBridgeChannelItemMarkup render the expected fields', () => {
    assert.match(G.tcBridgeReachProjectMarkup('bs', { id: 5, name: 'gamma' }, true, (s) => String(s)), /ProjectCheck_5/);
    assert.match(G.tcBridgeReachProjectMarkup('bs', { id: 5, name: 'gamma' }, true, (s) => String(s)), /out of reach/);
    const chan = G.tcBridgeChannelItemMarkup('bs', { channelId: 'c1', name: 'general', mode: 'watch-only', sendAllowed: false }, (s) => String(s));
    assert.match(chan, /id="bsToggleSend_c1"/);
    assert.match(chan, /Allow send/);
  });

  it('loadReach() paints the narrowing prompt and the project list from the real routes\' shape', async () => {
    const { doc, ui } = mounted({
      api: async (path) => {
        if (path === '/api/bridge/operator/reach/narrowing-prompt') {
          return { shouldPrompt: true, suggested: { type: 'group', groupId: 'g1', groupName: 'Fleet' }, dismissed: false };
        }
        return { reach: { optouts: [{ projectId: 2 }] } };
      }
    });
    ui.mount();
    await ui.loadReach();
    assert.equal(doc.getElementById('bsNarrowingPrompt').classList.contains('hidden'), false);
    assert.match(doc.getElementById('bsNarrowingPromptText').textContent, /Fleet/);
    // Dynamic list content: a string-level check on the raw markup, not a
    // live queryable element -- the mini-dom's id extraction only applies
    // to a root's own upgraded innerHTML setter, not a plain child's
    // (`test/_mini-dom.js`'s own documented limit; `bridge-step-up.js`'s
    // header comment names the same wall).
    assert.match(doc.getElementById('bsProjectList').innerHTML, /ProjectCheck_1/);
    assert.match(doc.getElementById('bsProjectList').innerHTML, /beta[\s\S]*out of reach/);
  });

  it('setReachBatch() is a no-op with nothing checked -- the checkbox-reading half needs a real browser '
    + '(.prawduct/operator-verification.md), but "nothing checked, no API call" is itself verified here', async () => {
    const calls = [];
    const { ui } = mounted({ api: async () => ({ reach: { optouts: [] } }), apiMutate: async (p, m, b) => { calls.push([p, m, b]); return { ok: true }; } });
    ui.mount();
    await ui.loadReach();
    assert.equal(await ui.setReachBatch(true), false);
    assert.equal(calls.length, 0);
  });

  it('dismissNarrowingPrompt() posts the dismissal, then reloads reach', async () => {
    const calls = [];
    let loadCount = 0;
    const { ui } = mounted({
      api: async () => { loadCount += 1; return { reach: { optouts: [] }, shouldPrompt: false }; },
      apiMutate: async (p, m, b) => { calls.push([p, m, b]); return { dismissed: true }; }
    });
    ui.mount();
    await ui.dismissNarrowingPrompt();
    assert.equal(calls[0][0], '/api/bridge/operator/reach/narrowing-prompt/dismiss');
    // loadReach() reads both the narrowing-prompt and the operator-status
    // routes per call (Promise.all), so one reload is 2 calls through this
    // generic mock, not 1.
    assert.equal(loadCount, 2, 'reach reloads after dismissal');
  });

  it('loadNotificationPolicy() reads every named event kind and paints the list', async () => {
    const { doc, ui } = mounted({
      api: async (path) => {
        if (path.endsWith('fleet-idle')) return { enabled: false, source: 'global' };
        if (path.endsWith('gateway-down')) return { enabled: true, source: 'default' };
        return null;
      }
    });
    ui.mount();
    await ui.loadNotificationPolicy();
    const html = doc.getElementById('bsPolicyList').innerHTML;
    assert.match(html, /fleet-idle: off \(global\)/);
    assert.match(html, /gateway-down: on \(default\)/);
  });

  it('setGlobalNotificationPolicy() posts the kind/enabled pair, then reloads the policy list', async () => {
    const calls = [];
    let loadCount = 0;
    const { ui } = mounted({
      api: async () => { loadCount += 1; return { enabled: false, source: 'global' }; },
      apiMutate: async (p, m, b) => { calls.push([p, m, b]); return { enabled: false, source: 'global' }; }
    });
    ui.mount();
    const ok = await ui.setGlobalNotificationPolicy('fleet-idle', false);
    assert.equal(ok, true);
    assert.equal(calls[0][0], '/api/bridge/operator/notification-policy/global');
    assert.equal(calls[0][1], 'POST');
    assert.equal(calls[0][2].eventKind, 'fleet-idle');
    assert.equal(calls[0][2].enabled, false);
    assert.ok(loadCount >= 1);
  });

  it('setProjectNotificationOverride() posts to the project-scoped route, enabled: null clears it', async () => {
    const calls = [];
    const { ui } = mounted({ apiMutate: async (p, m, b) => { calls.push([p, m, b]); return { ok: true }; } });
    ui.mount();
    await ui.setProjectNotificationOverride(7, 'gateway-down', null);
    assert.equal(calls[0][0], '/api/bridge/operator/notification-policy/project/7');
    assert.equal(calls[0][1], 'POST');
    assert.equal(calls[0][2].eventKind, 'gateway-down');
    assert.equal(calls[0][2].enabled, null);
  });

  it('loadChannels() paints the channel list and status', async () => {
    const { doc, ui } = mounted({
      api: async () => ({ channels: [{ channelId: 'c1', name: 'general', mode: 'watch-only', sendAllowed: false }] })
    });
    ui.mount();
    await ui.loadChannels();
    assert.equal(doc.getElementById('bsChannelsStatus').textContent, '1 watched channel(s)');
    assert.match(doc.getElementById('bsChannelList').innerHTML, /general/);
  });

  it('registerChannelFromForm() reads the static form fields and posts them, then reloads', async () => {
    const calls = [];
    let loadCount = 0;
    const { doc, ui } = mounted({
      api: async () => { loadCount += 1; return { channels: [] }; },
      apiMutate: async (p, m, b) => { calls.push([p, m, b]); return { ok: true }; },
      guildId: 'g1'
    });
    ui.mount();
    doc.getElementById('bsNewChannelId').value = 'c2';
    doc.getElementById('bsNewChannelName').value = 'Forum watch';
    const ok = await ui.registerChannelFromForm();
    assert.equal(ok, true);
    assert.equal(calls[0][0], '/api/bridge/operator/channels');
    assert.equal(calls[0][2].channelId, 'c2');
    assert.equal(calls[0][2].name, 'Forum watch');
    assert.equal(loadCount, 1, 'registering reloads the channel list');
  });

  it('registerChannelFromForm() is a no-op with no channel id entered', async () => {
    const calls = [];
    const { ui } = mounted({ apiMutate: async (p, m, b) => { calls.push([p, m, b]); return { ok: true }; } });
    ui.mount();
    assert.equal(await ui.registerChannelFromForm(), false);
    assert.equal(calls.length, 0);
  });

  it('updateChannel() patches the named channel', async () => {
    const calls = [];
    const { ui } = mounted({ api: async () => ({ channels: [] }), apiMutate: async (p, m, b) => { calls.push([p, m, b]); return { ok: true }; } });
    ui.mount();
    await ui.updateChannel('c1', { sendAllowed: true });
    assert.deepEqual(calls[0], ['/api/bridge/operator/channels/c1', 'PATCH', { sendAllowed: true }]);
  });

  it('loadWatchedMessages() returns the messages array, or [] on a failed read', async () => {
    const { ui } = mounted({ api: async () => ({ messages: [{ text: 'hi' }] }) });
    ui.mount();
    assert.deepEqual(await ui.loadWatchedMessages('c1'), [{ text: 'hi' }]);
    const { ui: ui2 } = mounted({ api: async () => null });
    ui2.mount();
    // Not deepEqual against []: the fallback literal is constructed inside
    // the vm-sandboxed module, the same cross-realm case this file's other
    // comments already name.
    assert.equal((await ui2.loadWatchedMessages('c1')).length, 0);
  });
});
