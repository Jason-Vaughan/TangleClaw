'use strict';

// #2031 (ADR 0023): the operator bridge end to end over HTTP, against the real
// server. An operator message goes in through the helper's route, reaches a
// project's session, comes back held, is released by the Master and is handed
// to the helper; the Hub and the Master pane are stand-ins. Three callers,
// three proofs, and none of them opens another's door.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { setLevel, setConsoleStream } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const bridgeStore = require('../lib/bridge-store');
const bridgeApi = require('../lib/bridge-api');
const gateway = require('../lib/bridge-gateway');
const handoff = require('../lib/bridge-handoff');
const bridgeReach = require('../lib/bridge-reach');
const { operatorHeaders } = require('./_shared-docs-callers');
const { install } = require('./_bridge-hub');
const { execFile } = require('node:child_process');

const TC_BIN = path.join(__dirname, '..', 'bin', 'tc');
/** A tracked file's text. */
const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const ALLOWED = { authorId: 'author1', spaceId: 'space1', channelId: 'chan1' };

let tmpDir;
let server;
let origin;
let hub;
let realDeps;
let masterCredential;
let masterGeneration;
let helperToken;
let seq = 0;

/** A signed-in operator, as `server.js` annotates the request. */
const SIGNED_IN = { tcSession: { username: 'rosie' }, tcGateState: 'guarding', headers: {}, socket: { remoteAddress: '127.0.0.1' } };
/** A dashboard-shaped request on an open gate: the operator in appearance only. */
const AMBIENT = { tcGateActive: false, tcGateState: 'open', headers: { 'sec-fetch-site': 'same-origin' } };

/**
 * One JSON request to the test server.
 * @param {string} method - HTTP method.
 * @param {string} apiPath - Path.
 * @param {object} [options]
 * @param {object} [options.headers] - Extra headers.
 * @param {object} [options.body] - JSON body.
 * @returns {Promise<{status: number, body: object}>}
 */
async function call(method, apiPath, options = {}) {
  const res = await fetch(`${origin}${apiPath}`, {
    method, headers: { 'content-type': 'application/json', ...(options.headers || {}) },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  return { status: res.status, body: await res.json() };
}

/**
 * Headers for a helper request, with a fresh nonce.
 * @param {object} [over] - Overrides.
 * @returns {object}
 */
function asHelper(over = {}) {
  return {
    [bridgeApi.HELPER_TOKEN_HEADER]: helperToken,
    [bridgeApi.HELPER_NONCE_HEADER]: crypto.randomBytes(16).toString('hex'),
    ...over
  };
}

/**
 * Collect what waits, as the helper does: every item comes under a lease.
 * @param {object} [headers] - Request headers; the helper's by default.
 * @returns {Promise<{status: number, body: object}>}
 */
function claim(headers = asHelper()) {
  return call('POST', '/api/bridge/helper/outbound/claim', { headers, body: { limit: 20 } });
}

/**
 * Acknowledge a claimed item under its lease.
 * @param {{outboundId: number, leaseId: string}} item - A claimed item.
 * @param {string} deliveredRef - The chat's id for the post.
 * @returns {Promise<{status: number, body: object}>}
 */
function ackItem(item, deliveredRef) {
  return call('POST', `/api/bridge/helper/outbound/${item.outboundId}/ack`, { headers: asHelper(), body: { leaseId: item.leaseId, parts: [deliveredRef], partCount: 1 } });
}

/**
 * Headers for a Master request.
 * @returns {object}
 */
function asMaster() {
  return { 'x-tangleclaw-bridge-credential': masterCredential };
}

/**
 * A Master write to a route.
 * @param {string} routeId - Route id.
 * @param {string} op - `route`, `answer`, `release`, `pin` or `close`.
 * @param {object} body - Fields beyond the request id.
 * @returns {Promise<{status: number, body: object}>}
 */
function masterWrites(routeId, op, body) {
  return call('POST', `/api/bridge/master/routes/${routeId}/${op}`, {
    headers: asMaster(), body: { requestId: `req-${op}-${++seq}-0000`, ...body }
  });
}

/**
 * The operator says something in the allowlisted channel.
 * @param {string} externalId - Chat message id.
 * @param {string} text - Message.
 * @returns {Promise<{status: number, body: object}>}
 */
function operatorWrites(externalId, text) {
  return call('POST', '/api/bridge/helper/inbound', { headers: asHelper(), body: { externalId, ...ALLOWED, text } });
}

/**
 * The operator writes, and the Project Master routes the message where the
 * gateway suggested, with its own route write over HTTP. Every inbound waits
 * for that decision; most of this file is about what happens after it.
 * @param {string} externalId - Chat message id.
 * @param {string} text - Message.
 * @returns {Promise<{status: number, body: object}>} The accept's answer, with the route's state as the decision left it.
 */
async function operatorSays(externalId, text) {
  const accepted = await operatorWrites(externalId, text);
  if (accepted.status !== 202 || accepted.body.replayed) return accepted;
  const routeId = accepted.body.routeId;
  const route = bridgeStore.routes.get(routeId);
  const suggestion = bridgeStore.audit.suggestionFor(routeId);
  if (!route || route.state !== 'awaiting-master' || !suggestion || !suggestion.to) return accepted;
  const routed = await masterWrites(routeId, 'route', { expectedVersion: route.version, to: suggestion.to === 'master' ? 'master' : suggestion.projectId });
  // A suggested project that is not running is not routed to: the message stays held, as it would with a real Master.
  // (This file's one store keeps an earlier test's conversation pin, which suggests its long-gone project.)
  if (routed.status === 409 && routed.body.code === 'TARGET_OFFLINE') return accepted;
  assert.equal(routed.status, 200, `the Master's route write: ${JSON.stringify(routed.body)}`);
  return { status: accepted.status, body: { ...accepted.body, state: routed.body.route.state } };
}

/**
 * A project with a live, launch-bound session and a workspace.
 * @param {string} name - Project name.
 * @returns {{project: object, sessionId: number, workspaceId: string}}
 */
function liveProject(name) {
  return hub.liveProject(name, tmpDir);
}

/**
 * The session replies over Medusa through the real send path, and the
 * gateway takes the arrival.
 * @param {object} target - What {@link liveProject} returned.
 * @param {string} inReplyTo - The Hub id it answers.
 * @param {string} text - The reply.
 * @returns {Promise<void>}
 */
async function sessionReplies(target, inReplyTo, text) {
  const sent = await hub.sessionSends(target, { inReplyTo, text });
  assert.equal(sent.status, 200, JSON.stringify(sent.body));
  gateway.drainInbox();
}

/**
 * The signed-in operator calls one of the operator's routes.
 * @param {string} method - HTTP method.
 * @param {string} apiPath - Declared path.
 * @param {object} [request] - `body`, `params`; `req` defaults to the signed-in operator.
 * @returns {Promise<{status: number, body: object}>}
 */
function asOperator(method, apiPath, request = {}) {
  return bridgeApi.handle(bridgeApi.routeFor(method, apiPath), { req: SIGNED_IN, headers: {}, ...request });
}

/**
 * Run the real `bin/tc` as the Master pane would.
 * @param {string[]} args - Arguments.
 * @param {object} [over] - Environment overrides.
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function tc(args, over = {}) {
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, TANGLECLAW_API: origin, TANGLECLAW_ROLE: 'master',
    [handoff.CREDENTIAL_ENV]: masterCredential, ...over
  };
  return new Promise((resolve) => {
    execFile(TC_BIN, args, { env, encoding: 'utf8' }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }));
  });
}

describe('bridge API: the round trip (#2031)', () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-bridge-gw-'));
    store._setBasePath(tmpDir);
    store.init();
    const { createServer } = require('../server');
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
    realDeps = { ...gateway._deps };
  });

  after(async () => {
    Object.assign(gateway._deps, realDeps);
    if (hub) hub.restore();
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    if (hub) hub.restore();
    hub = install();
    Object.assign(gateway._deps, {
      master: () => ({
        masterLiveness: () => ({ live: true, answered: true }),
        ensureMasterSession: () => ({ created: false }),
        getMasterMedusaStatus: () => ({ workspaceId: 'master-ws' }),
        masterListenerEnabled: () => true
      })
    });
    gateway._reset();

    const minted = handoff.mintCredential();
    masterGeneration = bridgeStore.masterCredentials.mint(minted.hash);
    bridgeStore.masterCredentials.activate(masterGeneration, minted.hash);
    masterCredential = minted.credential;

    // The operator sets the bridge up, through the operator's own handlers.
    await asOperator('POST', '/api/bridge/operator/disable');
    assert.equal((await asOperator('POST', '/api/bridge/operator/allowlist', { body: ALLOWED })).status, 200);
    helperToken = (await asOperator('POST', '/api/bridge/operator/helper-token')).body.token;
    assert.equal((await asOperator('POST', '/api/bridge/operator/enable')).status, 200);
  });

  it('carries a message to a project and its answer back, releasing nothing until the Master does', async () => {
    const alpha = liveProject(`Alpha${++seq}`);
    const accepted = await operatorSays(`m${++seq}`, `@${alpha.project.name} is the build green?`);
    assert.equal(accepted.status, 202);
    const routeId = accepted.body.routeId;
    assert.equal(accepted.body.state, 'routed');
    assert.equal(hub.fromGateway()[0].to, alpha.workspaceId);

    await sessionReplies(alpha, hub.fromGateway()[0].hubId, 'yes, all green');
    assert.deepEqual((await claim()).body.items, [],
      'a held reply is not handed to the helper');

    const read = await call('GET', `/api/bridge/master/routes/${routeId}`, { headers: asMaster() });
    assert.equal(read.body.route.state, 'reply-held');
    assert.deepEqual(read.body.bodies.map((b) => b.role), ['inbound', 'reply']);

    const released = await masterWrites(routeId, 'release', { expectedVersion: read.body.route.version });
    assert.deepEqual([released.status, released.body.route.state], [200, 'released']);

    const out = await claim();
    assert.equal(out.body.items.length, 1);
    const item = out.body.items[0];
    assert.deepEqual([item.kind, item.text, item.sourceLabel], ['reply', 'yes, all green', `Project Master, relaying ${alpha.project.name}`]);
    assert.equal(item.inReplyTo.channelId, ALLOWED.channelId);

    const ack = await ackItem(item, 'posted-1');
    assert.equal(ack.status, 200);
    const done = bridgeStore.routes.get(routeId);
    assert.deepEqual([done.state, done.closedBy], ['closed', 'gateway']);
    assert.ok(bridgeStore.routes.bodies(routeId).every((b) => b.text === null), 'every body is cleared once the chat has the answer');
    assert.deepEqual(bridgeStore.audit.forRoute(routeId).map((a) => `${a.op}:${a.actor}`),
      ['inbound:helper', 'suggest:gateway', 'route:master', 'dispatch:gateway', 'reply-held:session', 'release:master', 'delivered:helper']);
    assert.equal(bridgeStore.audit.forRoute(routeId).find((a) => a.op === 'release').masterGeneration, masterGeneration);
  });

  it('lets the Master answer an unaddressed message itself, with no session involved', async () => {
    const accepted = await operatorSays(`m${++seq}`, 'what is the fleet doing?');
    const routeId = accepted.body.routeId;
    const answered = await masterWrites(routeId, 'answer', { expectedVersion: bridgeStore.routes.get(routeId).version, text: 'Two sessions are working.' });
    assert.equal(answered.body.route.state, 'released');
    assert.equal(hub.fromGateway().length, 0);
    const item = (await claim()).body.items[0];
    assert.deepEqual([item.kind, item.sourceLabel, item.text], ['reply', 'Project Master', 'Two sessions are working.']);
  });

  it('has the Master route what the gateway could not, and never re-resolves its choice', async () => {
    const alpha = liveProject(`Alpha${++seq}`);
    const accepted = await operatorSays(`m${++seq}`, '@nobody please look at this');
    const routeId = accepted.body.routeId;
    assert.equal(accepted.body.state, 'awaiting-master');

    const bad = await masterWrites(routeId, 'route', { expectedVersion: bridgeStore.routes.get(routeId).version, to: 'no-such-project' });
    assert.equal(bad.body.code, 'UNKNOWN_DESTINATION');

    const routed = await masterWrites(routeId, 'route', { expectedVersion: bridgeStore.routes.get(routeId).version, to: alpha.project.name });
    assert.deepEqual([routed.status, routed.body.route.state, routed.body.route.resolvedBy, routed.body.route.destination.projectId],
      [200, 'routed', 'master', alpha.project.id]);
    assert.equal(hub.fromGateway().length, 1);

    const again = await masterWrites(routeId, 'route', { expectedVersion: bridgeStore.routes.get(routeId).version, to: 'master' });
    assert.equal(again.body.code, 'NOT_AWAITING_MASTER');
  });

  it('refuses a release with nothing held, an unsafe or empty answer, and a second answer', async () => {
    const accepted = await operatorSays(`m${++seq}`, '@master hello');
    const routeId = accepted.body.routeId;
    const version = () => bridgeStore.routes.get(routeId).version;
    assert.equal((await masterWrites(routeId, 'release', { expectedVersion: version() })).body.code, 'NO_REPLY_HELD');
    assert.equal((await masterWrites(routeId, 'answer', { expectedVersion: version(), text: '  ' })).body.code, 'ANSWER_REQUIRED');
    assert.equal((await masterWrites(routeId, 'answer', { expectedVersion: version(), text: 'safe\u202Eevil' })).body.code, 'ANSWER_NOT_DISPLAY_SAFE');
    assert.equal((await masterWrites(routeId, 'answer', { expectedVersion: version(), text: 'x'.repeat(8001) })).body.code, 'ANSWER_TOO_LONG');
    assert.equal((await masterWrites(routeId, 'answer', { expectedVersion: version(), text: 'fine' })).status, 200);
    assert.equal((await masterWrites(routeId, 'answer', { expectedVersion: version(), text: 'again' })).body.code, 'NOT_ANSWERABLE');
    assert.equal((await claim()).body.items.length >= 1, true);
  });

  it('an answer needs a routing decision behind it: a route nobody has routed cannot be answered, the Master\'s own included', async () => {
    const version = (id) => bridgeStore.routes.get(id).version;
    // A message addressed to the Master: suggested for the Master, and still waiting for the Master to say so.
    const waiting = (await operatorWrites(`m${++seq}`, '@master what is the fleet doing?')).body.routeId;
    assert.deepEqual([bridgeStore.routes.get(waiting).state, bridgeStore.audit.suggestionFor(waiting).to], ['awaiting-master', 'master']);
    const early = await masterWrites(waiting, 'answer', { expectedVersion: version(waiting), text: 'All quiet.' });
    assert.deepEqual([early.status, early.body.code, early.body.route.state], [409, 'NOT_ANSWERABLE', 'awaiting-master']);
    assert.equal(store.getDb().prepare("SELECT COUNT(*) AS n FROM bridge_outbound WHERE route_id = ? AND kind = 'reply'").get(waiting).n, 0, 'nothing was queued for the operator');
    assert.equal(bridgeStore.routes.body(waiting, 'answer'), null, 'and no answer text was stored');
    // The same from the real tc, in the words the Master will see.
    const typed = await tc(['bridge', 'answer', waiting, '--version', String(version(waiting)), '--text', 'All quiet.']);
    assert.deepEqual([typed.code, /NOT_ANSWERABLE/.test(typed.stderr)], [2, true]);
    // Routed to itself, it is answerable, and the audit shows the decision before the answer.
    const routed = await masterWrites(waiting, 'route', { expectedVersion: version(waiting), to: 'master' });
    assert.deepEqual([routed.status, routed.body.route.state], [200, 'routed']);
    const answered = await masterWrites(waiting, 'answer', { expectedVersion: version(waiting), text: 'All quiet.' });
    assert.deepEqual([answered.status, answered.body.route.state], [200, 'released']);
    assert.deepEqual(bridgeStore.audit.forRoute(waiting).filter((a) => a.outcome === 'applied').map((a) => a.op), ['suggest', 'route', 'dispatch', 'answer']);
    // A route that came back to the Master after a failed send is the same: it is routed again before anything is said for it.
    const name = liveProject(`Gone${++seq}`).project.name;
    hub.failSend = 'refused';
    const back = (await operatorWrites(`m${++seq}`, `@${name} hello`)).body.routeId;
    const sent = await masterWrites(back, 'route', { expectedVersion: version(back), to: name });
    hub.failSend = null;
    assert.equal(sent.body.route.state, 'awaiting-master', 'precondition: the send failed and the route is back');
    assert.equal((await masterWrites(back, 'answer', { expectedVersion: version(back), text: 'It could not be delivered.' })).body.code, 'NOT_ANSWERABLE');
    assert.equal((await masterWrites(back, 'route', { expectedVersion: version(back), to: 'master' })).status, 200);
    assert.equal((await masterWrites(back, 'answer', { expectedVersion: version(back), text: 'It could not be delivered.' })).status, 200);
  });

  it('lets the Master pin a conversation, and only a conversation', async () => {
    const alpha = liveProject(`Alpha${++seq}`);
    const first = await operatorSays(`m${++seq}`, '@master hello');
    const routeId = first.body.routeId;
    const pinned = await masterWrites(routeId, 'pin', { expectedVersion: bridgeStore.routes.get(routeId).version, to: alpha.project.id });
    assert.equal(pinned.status, 200);
    const pin = bridgeStore.pins.list().find((p) => p.conversationKey === ALLOWED.channelId && p.createdBy === 'master');
    assert.deepEqual([pin.scope, pin.destination.projectId], ['conversation', alpha.project.id]);

    const next = await operatorSays(`m${++seq}`, 'and this');
    assert.deepEqual([bridgeStore.audit.suggestionFor(next.body.routeId).by, bridgeStore.routes.get(next.body.routeId).resolvedBy, hub.fromGateway().length], ['pin', 'master', 1],
      'the pin is what the gateway suggested; the Master routed it');
    assert.equal((await asOperator('DELETE', '/api/bridge/operator/pins/:pinId', { params: { pinId: pin.pinId } })).status, 200);
  });

  it('the Master drives every routing verb through the real tc', async () => {
    const alpha = liveProject(`Alpha${++seq}`);
    const waiting = (await operatorSays(`m${++seq}`, '@nobody look at this')).body.routeId;
    const version = (id) => String(bridgeStore.routes.get(id).version);

    // A project id on the command line is a number, not a name.
    const routed = await tc(['bridge', 'route', waiting, '--version', version(waiting), '--to', String(alpha.project.id)]);
    assert.equal(routed.code, 0, routed.stderr);
    assert.match(routed.stdout, new RegExp(`is now routed, to project #${alpha.project.id}`));
    assert.equal(hub.fromGateway()[0].to, alpha.workspaceId);

    await sessionReplies(alpha, hub.fromGateway()[0].hubId, 'done');
    const released = await tc(['bridge', 'release', waiting, '--version', version(waiting)]);
    assert.equal(released.code, 0, released.stderr);
    assert.match(released.stdout, /held reply .* is released to the operator as your answer/);

    const own = (await operatorSays(`m${++seq}`, '@master a question for the Master')).body.routeId;
    const pinned = await tc(['bridge', 'pin', own, '--version', version(own), '--to', alpha.project.name]);
    assert.equal(pinned.code, 0, pinned.stderr);
    const file = path.join(tmpDir, 'answer.txt');
    fs.writeFileSync(file, 'An answer from a file.');
    const answered = await tc(['bridge', 'answer', own, '--version', version(own), '--text-file', file]);
    assert.equal(answered.code, 0, answered.stderr);
    assert.equal(bridgeStore.routes.body(own, 'answer').text, 'An answer from a file.');

    const usage = await tc(['bridge', 'answer', own, '--version', '1']);
    assert.deepEqual([usage.code, /exactly one of --text or --text-file/.test(usage.stderr)], [1, true]);
    const missing = await tc(['bridge', 'answer', own, '--version', '1', '--text-file', path.join(tmpDir, 'none.txt')]);
    assert.deepEqual([missing.code, /could not read/.test(missing.stderr)], [1, true]);
    const refused = await tc(['bridge', 'answer', own, '--version', version(own), '--text', 'again']);
    assert.deepEqual([refused.code, /NOT_ANSWERABLE/.test(refused.stderr)], [2, true]);
    const noTo = await tc(['bridge', 'route', own, '--version', '1']);
    assert.deepEqual([noTo.code, /needs --to/.test(noTo.stderr)], [1, true]);
  });

  it('a disabled bridge answers exactly what winds it down, and refuses every other Master, helper and session route', async () => {
    // The whole list, from the route table itself: adding to it, or taking from it, is a decision.
    const answered = bridgeApi.ROUTES.filter((r) => r.whileDisabled).map((r) => `${r.method} ${r.path}`).sort();
    assert.deepEqual(answered, [
      'GET /api/bridge/master/destinations',
      'GET /api/bridge/master/nicknames',
      'GET /api/bridge/master/nicknames/:name',
      'GET /api/bridge/master/outbound/blocked',
      'GET /api/bridge/master/routes',
      'GET /api/bridge/master/routes/:routeId',
      'GET /api/bridge/master/status',
      'POST /api/bridge/helper/preflight',
      'POST /api/bridge/master/circuit/:episodeId/ack',
      'POST /api/bridge/master/circuit/reset',
      'POST /api/bridge/master/outbound/:outboundId/withdraw',
      'POST /api/bridge/master/routes/:routeId/close'
    ]);
    const session = liveProject(`Gamma${++seq}`);
    const headersFor = {
      master: () => asMaster(),
      helper: () => asHelper(),
      session: () => ({ 'x-tangleclaw-project-id': String(session.project.id), 'x-tangleclaw-launch-id': session.launchId })
    };
    await asOperator('POST', '/api/bridge/operator/disable');
    bridgeApi._resetRateLimits();
    const gated = bridgeApi.ROUTES.filter((r) => r.principal !== 'operator');
    assert.equal(gated.length, bridgeApi.ROUTES.filter((r) => ['master', 'helper', 'session'].includes(r.principal)).length);
    let refused = 0;
    for (const route of gated) {
      // Any id will do: a refusal for the bridge being off comes before the route looks at it.
      const apiPath = route.path.replace(/:[A-Za-z]+/g, '1');
      const res = await call(route.method, apiPath, { headers: headersFor[route.principal](), body: route.method === 'GET' ? undefined : { requestId: `req-off-${++seq}-0000`, expectedVersion: 1 } });
      const label = `${route.method} ${route.path}`;
      if (route.whileDisabled) {
        assert.notEqual(res.body.code, 'BRIDGE_DISABLED', `${label} is answered while disabled`);
        assert.ok(![401, 403].includes(res.status), `${label}: ${res.status} ${res.body.code}`);
      } else {
        assert.deepEqual([res.status, res.body.code], [409, 'BRIDGE_DISABLED'], label);
        refused += 1;
      }
    }
    assert.equal(refused, gated.length - answered.length, 'every other one of them');
    assert.ok(refused >= 14, `${refused} routes refused`);
    bridgeApi._resetRateLimits();
  });

  it('rollback, as the runbook has it: disable, then the Master lists the open routes and closes each, and no exchange is left open', async () => {
    const exchanges = require('../lib/medusa-exchanges');
    const alpha = liveProject(`Alpha${++seq}`);
    const beta = liveProject(`Beta${++seq}`);
    const routed = (await operatorSays(`m${++seq}`, `@${alpha.project.name} still waiting on a project`)).body.routeId;
    const other = (await operatorSays(`m${++seq}`, `@${beta.project.name} and another`)).body.routeId;
    const forMaster = (await operatorSays(`m${++seq}`, 'unaddressed, so it waits on the Master')).body.routeId;
    const mine = [routed, other, forMaster];
    /** @returns {string[]} The gateway's open sends for this test's routes. */
    const openSends = () => exchanges.openSystemOwned(gateway.GATEWAY_KEY).map((x) => x.request_id).filter((id) => mine.some((r) => id.startsWith(`bridge:${r}:`))).sort();
    assert.deepEqual(openSends(), [`bridge:${other}:send1`, `bridge:${routed}:send1`].sort());

    // Step 1: the operator disables the bridge.
    assert.equal((await asOperator('POST', '/api/bridge/operator/disable')).status, 200);
    assert.deepEqual(openSends(), [`bridge:${other}:send1`, `bridge:${routed}:send1`].sort(), 'disabling alone closes nothing: those routes still wait');

    // Step 1b: the Master lists what is open. Disabled, it can still see it, and how many.
    const status = await tc(['bridge', 'status']);
    // Disabled, the Master is still told how many routes are open: they are what it is there to close.
    assert.match(status.stdout, new RegExp(`^Operator bridge: DISABLED; ${bridgeStore.routes.list().length} open route\\(s\\) — enabling it is the operator's alone`));
    assert.ok(bridgeStore.routes.list().length >= 3);
    const count = (await call('GET', '/api/bridge/master/status', { headers: asMaster() })).body.openRoutes;
    const listed = await call('GET', '/api/bridge/master/routes', { headers: asMaster() });
    assert.equal(listed.status, 200, JSON.stringify(listed.body));
    assert.equal(listed.body.routes.length, count, 'status reports the true count');
    for (const routeId of mine) assert.ok(listed.body.routes.some((r) => r.routeId === routeId), `${routeId} is listed`);
    assert.match((await tc(['bridge', 'routes'])).stdout, new RegExp(`^${count} route\\(s\\), oldest first:`));
    // It cannot answer or reroute one: only close.
    const refused = await masterWrites(forMaster, 'answer', { expectedVersion: bridgeStore.routes.get(forMaster).version, text: 'too late' });
    assert.deepEqual([refused.status, refused.body.code], [409, 'BRIDGE_DISABLED']);

    // It closes each with the version the listing gave it.
    for (const route of listed.body.routes) {
      const closed = await tc(['bridge', 'close', route.routeId, '--version', String(route.version)]);
      assert.equal(closed.code, 0, `${route.routeId}: ${closed.stderr}`);
    }
    // → Expected: the listing is empty, and nothing of the gateway's is left open.
    assert.match((await tc(['bridge', 'routes'])).stdout, /^No routes in those states\./);
    assert.equal((await call('GET', '/api/bridge/master/status', { headers: asMaster() })).body.openRoutes, 0);
    assert.deepEqual(openSends(), []);
    for (const routeId of [routed, other]) {
      const send = store.medusaExchanges.getByRequestId(`bridge:${routeId}:send1`);
      assert.deepEqual([send.state, send.terminal_code], ['closed', 'system-owner-closed'], routeId);
      assert.equal(bridgeStore.routes.bodies(routeId).every((b) => b.text === null), true, 'and no message text is held');
    }
    assert.equal(exchanges.pendingWakeCount(alpha.workspaceId), 0, 'nothing nudges the project for a message nobody will answer');
  });

  it('the Master moving a route ends the gateway\'s own exchange for it at once, and leaves none open that nothing waits on', async () => {
    const exchanges = require('../lib/medusa-exchanges');
    /** @returns {string[]} The gateway's open sends, by request id. */
    const open = () => exchanges.openSystemOwned(gateway.GATEWAY_KEY).map((x) => x.request_id).sort();
    const startedWith = open();
    const alpha = liveProject(`Alpha${++seq}`);
    const beta = liveProject(`Beta${++seq}`);

    // Closed by the Master while routed: no pass is needed for its exchange to end.
    const one = (await operatorSays(`m${++seq}`, `@${alpha.project.name} first`)).body.routeId;
    assert.deepEqual(open(), [...startedWith, `bridge:${one}:send1`].sort());
    const closed = await masterWrites(one, 'close', { expectedVersion: bridgeStore.routes.get(one).version });
    assert.equal(closed.body.route.state, 'closed');
    const ended = store.medusaExchanges.getByRequestId(`bridge:${one}:send1`);
    assert.deepEqual([ended.state, ended.terminal_code], ['closed', 'system-owner-closed']);
    assert.deepEqual(open(), startedWith);

    // Answered by the Master while routed, without waiting for the session: the same.
    const two = (await operatorSays(`m${++seq}`, `@${alpha.project.name} second`)).body.routeId;
    const read = await call('GET', `/api/bridge/master/routes/${two}`, { headers: asMaster() });
    const answered = await masterWrites(two, 'answer', { expectedVersion: read.body.route.version, text: 'I will answer this one myself.' });
    assert.equal(answered.body.route.state, 'released', JSON.stringify(answered.body));
    assert.equal(store.medusaExchanges.getByRequestId(`bridge:${two}:send1`).terminal_code, 'system-owner-closed');
    assert.deepEqual(open(), startedWith);

    // Rerouted by the Master after its target went away: the new attempt is open and the old one is not.
    const three = (await operatorSays(`m${++seq}`, `@${alpha.project.name} third`)).body.routeId;
    exchanges.markRecipientRetired(alpha.workspaceId);
    await gateway.tick();
    assert.equal(bridgeStore.routes.get(three).state, 'awaiting-master');
    const rerouted = await masterWrites(three, 'route', { expectedVersion: bridgeStore.routes.get(three).version, to: beta.project.name });
    assert.equal(rerouted.status, 200, JSON.stringify(rerouted.body));
    assert.equal(bridgeStore.routes.get(three).state, 'routed');
    const mine = open().filter((id) => id.startsWith(`bridge:${three}:`));
    assert.equal(mine.length, 1, `exactly one open send for the route: ${mine}`);
    assert.equal(store.medusaExchanges.getByRequestId(mine[0]).recipient_workspace_id, beta.workspaceId);
    assert.equal(store.medusaExchanges.getByRequestId(`bridge:${three}:send1`).state, 'recipient_retired');
  });

  it('withdrawing a route\'s answer before it is posted closes the route and clears its text', async () => {
    /**
     * The operator writes, and the Master answers: a released route and its one unposted answer.
     * @param {string} text - The answer.
     * @returns {Promise<{routeId: string, itemId: number}>}
     */
    const answered = async (text) => {
      const routeId = (await operatorSays(`m${++seq}`, '@master a question for the Master')).body.routeId;
      const done = await masterWrites(routeId, 'answer', { expectedVersion: bridgeStore.routes.get(routeId).version, text });
      assert.equal(done.body.route.state, 'released');
      const item = store.getDb().prepare("SELECT outbound_id FROM bridge_outbound WHERE route_id = ? AND kind = 'reply'").get(routeId);
      return { routeId, itemId: item.outbound_id };
    };
    const closures = (routeId) => bridgeStore.audit.forRoute(routeId).filter((a) => a.op === 'answer-withdrawn');

    // By the Master, with its command.
    const one = await answered('An answer the Master thinks better of.');
    assert.ok(bridgeStore.routes.body(one.routeId, 'answer').text, 'precondition: the answer\'s text is held');
    // A notice about the same route is waiting too. It must not post for a route that is closed.
    assert.equal(bridgeStore.outbound.enqueueStatus(one.routeId, 'pending').created, true);
    const waitingNotices = () => store.getDb().prepare("SELECT state, drop_code FROM bridge_outbound WHERE route_id = ? AND kind <> 'reply'").all(one.routeId).map((r) => [r.state, r.drop_code]);
    const queued = waitingNotices().filter(([state]) => state === 'ready').length;
    assert.ok(queued >= 1, 'precondition: something besides the answer is queued for the route');
    const gone = await tc(['bridge', 'withdraw', String(one.itemId)]);
    assert.equal(gone.code, 0, gone.stderr);
    const route = bridgeStore.routes.get(one.routeId);
    assert.deepEqual([route.state, route.closedBy], ['closed', 'master'], 'nothing more is coming for it, so it does not stay released');
    for (const role of ['inbound', 'answer']) {
      const body = bridgeStore.routes.body(one.routeId, role);
      assert.ok(!body || body.text === null, `${role} text is cleared`);
    }
    assert.deepEqual(closures(one.routeId).map((a) => [a.actor, a.outcome, a.detail.outboundId, a.masterGeneration]), [['master', 'applied', one.itemId, masterGeneration]]);
    assert.deepEqual(waitingNotices().filter(([state]) => state === 'ready'), [], 'what else was queued for the route went with it');
    assert.ok(waitingNotices().some(([state, why]) => state === 'dropped' && why === 'withdrawn'));
    assert.equal(closures(one.routeId)[0].detail.withdrawn, queued);
    assert.deepEqual([bridgeStore.outbound.get(one.itemId).state, bridgeStore.outbound.get(one.itemId).dropCode], ['dropped', 'withdrawn']);
    // The Master cannot answer it again: the operator writes again to be answered.
    const late = await masterWrites(one.routeId, 'answer', { expectedVersion: route.version, text: 'second thoughts' });
    assert.equal(late.status, 409);

    // By the signed-in operator, the same.
    const two = await answered('An answer the operator stops.');
    const stopped = await bridgeApi.handle(bridgeApi.routeFor('POST', '/api/bridge/operator/outbound/:outboundId/withdraw'),
      { req: SIGNED_IN, headers: SIGNED_IN.headers, params: { outboundId: String(two.itemId) }, body: { requestId: `req-op-withdraw-${++seq}-00` } });
    assert.equal(stopped.status, 200);
    assert.deepEqual([bridgeStore.routes.get(two.routeId).state, bridgeStore.routes.get(two.routeId).closedBy], ['closed', 'operator']);
    assert.deepEqual(closures(two.routeId).map((a) => [a.actor, a.proof, a.detail.user]), [['operator', 'verified-session', 'rosie']], 'on the record with who did it');

    // Withdrawing something that is not a route's answer closes no route.
    const three = await answered('An answer that is left alone.');
    const text = 'a notice of its own';
    const notice = bridgeStore.outbound.enqueue({
      idemKey: `notify:operator-needed:lone-${++seq}`, kind: 'notification', notifyType: 'operator-needed', sourceLabel: 'TangleClaw', text, digest: bridgeStore.digest(text)
    }).outboundId;
    assert.equal((await tc(['bridge', 'withdraw', String(notice)])).code, 0);
    assert.equal(bridgeStore.routes.get(three.routeId).state, 'released');
    assert.deepEqual(closures(three.routeId), []);
    // Nor does withdrawing a notice that is about the route: only its answer going closes it.
    bridgeStore.outbound.enqueueStatus(three.routeId, 'pending');
    const about = store.getDb().prepare("SELECT outbound_id FROM bridge_outbound WHERE route_id = ? AND kind <> 'reply' AND state = 'ready'").get(three.routeId).outbound_id;
    assert.equal((await tc(['bridge', 'withdraw', String(about)])).code, 0);
    assert.deepEqual([bridgeStore.outbound.get(about).state, bridgeStore.routes.get(three.routeId).state, closures(three.routeId).length], ['dropped', 'released', 0]);
    assert.ok(bridgeStore.routes.body(three.routeId, 'answer').text, 'and its answer is still held to be posted');

    // A circuit reset that withdraws what it caught closes the routes of the answers among them.
    // A route with its answer and one notice waiting: the helper will be holding the notice when the reset is asked for.
    const caught = await answered('An answer the circuit catches.');
    assert.equal(bridgeStore.outbound.enqueueStatus(caught.routeId, 'pending').created, true);
    const claimed = (await claim()).body.items.find((i) => i.outboundId === caught.itemId);
    const reported = await call('POST', `/api/bridge/helper/outbound/${caught.itemId}/failure`, { headers: asHelper(), body: { leaseId: claimed.leaseId, reason: 'chat-channel-missing' } });
    assert.equal(reported.body.circuit.opened, true);
    // The helper claimed the route's waiting notice in the same pass and still holds it. Withdrawing the answer
    // would close the route and pull that notice out of the helper's hands, so the reset is refused whole.
    const heldNotice = store.getDb().prepare(
      "SELECT o.outbound_id FROM bridge_outbound o JOIN bridge_outbound_leases l ON l.outbound_id = o.outbound_id AND l.state = 'live' WHERE o.route_id = ?"
    ).get(caught.routeId);
    assert.ok(heldNotice, 'precondition: another item of the route is in the helper\'s hands');
    const snapshot = () => JSON.stringify([
      bridgeStore.routes.get(caught.routeId), store.getDb().prepare('SELECT outbound_id, state, drop_code, block_code, text FROM bridge_outbound WHERE route_id = ? ORDER BY outbound_id').all(caught.routeId),
      bridgeStore.circuit.open().episodeId
    ]);
    const untouched = snapshot();
    const refusedReset = await tc(['bridge', 'reset', '--withdraw']);
    assert.equal(refusedReset.code, 2);
    assert.match(refusedReset.stderr, /refused \[OUTBOUND_IN_FLIGHT\]/);
    assert.equal(snapshot(), untouched, 'the route, every item of it and the open episode are exactly as they were');
    assert.equal(closures(caught.routeId).length, 0);
    // Once that lease has run out with nothing posted, the same reset goes through.
    const realNow = gateway._deps.now;
    try {
      const later = Date.now() + bridgeStore.LEASE_MS + 1000;
      gateway._deps.now = () => new Date(later).toISOString();
      assert.equal((await tc(['bridge', 'reset', '--withdraw'])).code, 0);
    } finally {
      gateway._deps.now = realNow;
    }
    assert.deepEqual([bridgeStore.routes.get(caught.routeId).state, bridgeStore.routes.get(caught.routeId).closedBy, closures(caught.routeId).length], ['closed', 'master', 1]);
    assert.deepEqual([bridgeStore.outbound.get(heldNotice.outbound_id).state, bridgeStore.outbound.get(heldNotice.outbound_id).dropCode], ['dropped', 'withdrawn'], 'and the notice goes with its route');
    // And one that puts them back leaves the route waiting for its answer to post.
    const four = await answered('An answer that is put back.');
    const again = (await claim()).body.items.find((i) => i.outboundId === four.itemId);
    await call('POST', `/api/bridge/helper/outbound/${four.itemId}/failure`, { headers: asHelper(), body: { leaseId: again.leaseId, reason: 'chat-channel-missing' } });
    assert.equal((await tc(['bridge', 'reset', '--requeue'])).code, 0);
    assert.equal(bridgeStore.routes.get(four.routeId).state, 'released');
  });

  it('a send that could not be confirmed is the Master\'s to answer, and cannot be routed again', async () => {
    const name = liveProject(`Alpha${++seq}`).project.name;
    hub.failSend = 'unknown';
    const routeId = (await operatorSays(`m${++seq}`, `@${name} hello`)).body.routeId;
    hub.failSend = null;
    const version = () => bridgeStore.routes.get(routeId).version;
    assert.deepEqual([bridgeStore.routes.get(routeId).state, bridgeStore.routes.get(routeId).failureCode], ['accepted', 'send-unconfirmed']);

    const reroute = await masterWrites(routeId, 'route', { expectedVersion: version(), to: name });
    assert.deepEqual([reroute.status, reroute.body.code], [409, 'NOT_AWAITING_MASTER']);
    assert.equal(hub.fromGateway().length, 0, 'the Master\'s route does not send it either');

    const answered = await masterWrites(routeId, 'answer', { expectedVersion: version(), text: 'I could not confirm that reached them. I will follow up.' });
    assert.deepEqual([answered.status, answered.body.route.state], [200, 'released']);
    const externalId = bridgeStore.routes.get(routeId).externalId;
    const items = (await claim()).body.items
      .filter((i) => i.inReplyTo && i.inReplyTo.externalId === externalId);
    assert.deepEqual(items.map((i) => i.kind).sort(), ['failure', 'reply'], 'one notice that it is unconfirmed, and one answer');

    // An accepted route with no such mark is still being resolved or sent: not the Master's to answer.
    bridgeStore.routes.accept({ routeId: 'rt_plain', externalId: `m${++seq}`, ...ALLOWED, text: 'x', digest: bridgeStore.digest('x') });
    const plain = await masterWrites('rt_plain', 'answer', { expectedVersion: 1, text: 'too early' });
    assert.deepEqual([plain.status, plain.body.code], [409, 'NOT_ANSWERABLE']);
  });

  it('an acknowledgement and the route\'s close land together, and a repeat changes nothing', async () => {
    const accepted = await operatorSays(`m${++seq}`, '@master hello');
    const routeId = accepted.body.routeId;
    await masterWrites(routeId, 'answer', { expectedVersion: bridgeStore.routes.get(routeId).version, text: 'hi' });
    const externalId = bridgeStore.routes.get(routeId).externalId;
    const item = (await claim()).body.items
      .find((i) => i.kind === 'reply' && i.inReplyTo.externalId === externalId);
    const ack = () => ackItem(item, 'posted-9');
    assert.deepEqual([(await ack()).body.replayed, (await ack()).body.replayed], [false, true]);
    assert.equal(bridgeStore.routes.get(routeId).state, 'closed');
    assert.equal(bridgeStore.audit.forRoute(routeId).filter((a) => a.op === 'delivered').length, 1);
    const other = await ackItem(item, 'posted-10');
    assert.equal(other.body.code, 'ACK_MISMATCH');
  });

  it('a claim is named by its nonce: asking again returns the same leases, and a changed request is refused', async () => {
    const accepted = await operatorSays(`m${++seq}`, '@master hello');
    const routeId = accepted.body.routeId;
    await masterWrites(routeId, 'answer', { expectedVersion: bridgeStore.routes.get(routeId).version, text: 'hi' });
    const headers = asHelper();
    const first = await call('POST', '/api/bridge/helper/outbound/claim', { headers, body: { limit: 20 } });
    const again = await call('POST', '/api/bridge/helper/outbound/claim', { headers, body: { limit: 20 } });
    assert.deepEqual([first.status, first.body.replayed, again.status, again.body.replayed], [200, false, 200, true]);
    assert.ok(first.body.items.length >= 1);
    assert.deepEqual(again.body.items, first.body.items);
    for (const item of first.body.items) assert.match(item.leaseId, /^bol_[A-Za-z0-9_-]{22}$/);

    const changed = await call('POST', '/api/bridge/helper/outbound/claim', { headers, body: { limit: 5 } });
    assert.deepEqual([changed.status, changed.body.code], [409, 'NONCE_REUSED']);
    const asInbound = await call('POST', '/api/bridge/helper/inbound', { headers, body: { externalId: `m${++seq}`, ...ALLOWED, text: 'x' } });
    assert.equal(asInbound.body.code, 'NONCE_REUSED', 'a claim\'s nonce is spent for every other write');
    const noNonce = await call('POST', '/api/bridge/helper/outbound/claim', { headers: { [bridgeApi.HELPER_TOKEN_HEADER]: helperToken }, body: {} });
    assert.deepEqual([noNonce.status, noNonce.body.code], [400, 'NONCE_REQUIRED']);
    const badLimit = await call('POST', '/api/bridge/helper/outbound/claim', { headers: asHelper(), body: { limit: 500 } });
    assert.deepEqual([badLimit.status, badLimit.body.code], [400, 'BAD_CLAIM']);

    const reading = await call('GET', '/api/bridge/helper/outbound', { headers: asHelper() });
    assert.equal(reading.status, 404, 'there is no way to read the mailbox without claiming from it');
  });

  it('an acknowledgement over the route needs its lease, from the token that holds it', async () => {
    const accepted = await operatorSays(`m${++seq}`, '@master hello');
    const routeId = accepted.body.routeId;
    await masterWrites(routeId, 'answer', { expectedVersion: bridgeStore.routes.get(routeId).version, text: 'hi' });
    const externalId = bridgeStore.routes.get(routeId).externalId;
    const item = (await claim()).body.items.find((i) => i.kind === 'reply' && i.inReplyTo.externalId === externalId);
    const post = (body) => call('POST', `/api/bridge/helper/outbound/${item.outboundId}/ack`, { headers: asHelper(), body });

    const bare = await post({ parts: ['posted-20'], partCount: 1 });
    assert.deepEqual([bare.status, bare.body.code], [400, 'LEASE_REQUIRED']);
    const oneId = await post({ deliveredRef: 'posted-20', leaseId: item.leaseId });
    assert.deepEqual([oneId.status, oneId.body.code], [400, 'BAD_ACK'], 'an acknowledgement always gives every part and the count');
    const wrong = await post({ parts: ['posted-20'], partCount: 1, leaseId: 'bol_nosuchlease00000000000' });
    assert.deepEqual([wrong.status, wrong.body.code], [404, 'LEASE_NOT_FOUND']);
    assert.equal(bridgeStore.routes.get(routeId).state, 'released', 'neither closed the route');

    // The operator replaces the token: what the old one held is not the new one's to acknowledge.
    helperToken = (await asOperator('POST', '/api/bridge/operator/helper-token')).body.token;
    const stolen = await post({ parts: ['posted-20'], partCount: 1, leaseId: item.leaseId });
    assert.deepEqual([stolen.status, stolen.body.code], [403, 'LEASE_NOT_YOURS']);
    const mine = (await claim()).body.items.find((i) => i.outboundId === item.outboundId);
    assert.equal((await ackItem(mine, 'posted-20')).status, 200);
    assert.equal(bridgeStore.routes.get(routeId).state, 'closed');
  });

  it('records every part over the route, and a reply to any of them is the Master\'s to read as a reply to that item', async () => {
    const text = 'Milestone: the suite is green.';
    const id = bridgeStore.outbound.enqueue({
      idemKey: `notify:operator-needed:parts-${++seq}`, kind: 'notification', notifyType: 'operator-needed', sourceLabel: 'TangleClaw',
      text, digest: bridgeStore.digest(text)
    }).outboundId;
    const item = (await claim()).body.items.find((i) => i.outboundId === id);
    const parts = [`p${++seq}a`, `p${seq}b`, `p${seq}c`];
    const post = (body, headers = asHelper()) => call('POST', `/api/bridge/helper/outbound/${id}/ack`, { headers, body });

    const partial = await post({ leaseId: item.leaseId, parts: parts.slice(0, 2), partCount: 3 });
    assert.deepEqual([partial.status, partial.body.code], [400, 'BAD_ACK']);
    const noToken = await post({ leaseId: item.leaseId, parts, partCount: 3 }, { [bridgeApi.HELPER_NONCE_HEADER]: crypto.randomBytes(16).toString('hex') });
    assert.deepEqual([noToken.status, noToken.body.code], [401, 'HELPER_TOKEN_REQUIRED']);
    assert.equal((await post({ leaseId: item.leaseId, parts, partCount: 3 }, asMaster())).status, 401, 'the Master\'s credential does not acknowledge');
    assert.equal(bridgeStore.outbound.get(id).state, 'ready');

    const done = await post({ leaseId: item.leaseId, parts, partCount: 3 });
    assert.deepEqual([done.status, done.body.replayed, done.body.parts], [200, false, 3]);
    assert.equal((await post({ leaseId: item.leaseId, parts, partCount: 3 })).body.replayed, true);
    assert.equal((await post({ leaseId: item.leaseId, parts: [parts[0]], partCount: 1 })).body.code, 'ACK_MISMATCH');

    // The operator replies to the middle part.
    const replyId = `m${++seq}`;
    const reply = await call('POST', '/api/bridge/helper/inbound', { headers: asHelper(), body: { externalId: replyId, ...ALLOWED, replyToExternalId: parts[1], text: 'who needs me?' } });
    assert.equal(reply.status, 202);
    const read = await call('GET', `/api/bridge/master/routes/${reply.body.routeId}`, { headers: asMaster() });
    assert.deepEqual([read.body.route.state, read.body.route.destination, read.body.route.suggestion],
      ['awaiting-master', null, { by: 'outbound-correlation', to: 'master', projectId: null, reason: null }], 'the Master is shown what it answers as a suggestion, and decides');
    // The list of waiting routes shows the same, for every route on it.
    const waitingList = await call('GET', '/api/bridge/master/routes?states=awaiting-master', { headers: asMaster() });
    const listedRoute = waitingList.body.routes.find((r) => r.routeId === reply.body.routeId);
    assert.deepEqual(listedRoute.suggestion, read.body.route.suggestion);
    assert.ok(waitingList.body.routes.every((r) => 'suggestion' in r), 'each listed route says what was suggested, or null');
    assert.deepEqual(read.body.route.replyContext, {
      repliedExternalId: parts[1], canonicalExternalId: parts[0], outboundId: id, partIndex: 1, partCount: 3,
      kind: 'notification', notifyType: 'operator-needed', routeId: null, candidateId: null, candidateKind: null, questionId: null
    });
    assert.equal(read.body.bodies.find((b) => b.role === 'inbound').text, 'who needs me?');
    assert.equal(hub.fromGateway().length, 0, 'it went to no session');

    const shown = await tc(['bridge', 'read', reply.body.routeId]);
    assert.equal(shown.code, 0, shown.stderr);
    assert.match(shown.stdout, new RegExp(`answers posted operator-needed \\(item ${id}, part 2 of 3, message ${parts[1]}, first ${parts[0]}\\)`));

    // Somebody else replying to the same message is refused before anything is recorded.
    const stranger = await call('POST', '/api/bridge/helper/inbound', {
      headers: asHelper(), body: { externalId: `m${++seq}`, ...ALLOWED, authorId: 'stranger', replyToExternalId: parts[1], text: 'me too' }
    });
    assert.deepEqual([stranger.status, stranger.body.code], [403, 'NOT_ALLOWLISTED']);
  });

  it('closing a route withdraws its unposted answer, but not while the helper holds it', async () => {
    const realNow = gateway._deps.now;
    try {
      const accepted = await operatorSays(`m${++seq}`, '@master hello');
      const routeId = accepted.body.routeId;
      await masterWrites(routeId, 'answer', { expectedVersion: bridgeStore.routes.get(routeId).version, text: 'an answer the Master thinks better of' });
      const externalId = bridgeStore.routes.get(routeId).externalId;
      const item = (await claim()).body.items.find((i) => i.kind === 'reply' && i.inReplyTo.externalId === externalId);
      const version = () => bridgeStore.routes.get(routeId).version;

      const early = await masterWrites(routeId, 'close', { expectedVersion: version() });
      assert.deepEqual([early.status, early.body.code, early.body.route.state], [409, 'OUTBOUND_IN_FLIGHT', 'released']);
      assert.equal(bridgeStore.outbound.get(item.outboundId).state, 'ready', 'the helper may be posting it at this moment');

      // The lease lapses with nothing posted. Now the close goes through, and takes the answer with it.
      const after = Date.now() + bridgeStore.LEASE_MS + 1000;
      gateway._deps.now = () => new Date(after).toISOString();
      const unposted = store.getDb().prepare("SELECT COUNT(*) AS n FROM bridge_outbound WHERE route_id = ? AND state = 'ready'").get(routeId).n;
      const closed = await masterWrites(routeId, 'close', { expectedVersion: version() });
      assert.deepEqual([closed.status, closed.body.route.state], [200, 'closed']);
      const withdrawn = bridgeStore.outbound.get(item.outboundId);
      assert.deepEqual([withdrawn.state, withdrawn.dropCode, withdrawn.text], ['dropped', 'withdrawn', null]);
      assert.equal(bridgeStore.audit.forRoute(routeId).find((a) => a.op === 'close' && a.outcome === 'applied').detail.withdrawn, unposted,
        'everything of the route that was not yet posted, the answer and any notice with it');
      assert.equal(store.getDb().prepare("SELECT COUNT(*) AS n FROM bridge_outbound WHERE route_id = ? AND state = 'ready'").get(routeId).n, 0);

      // A helper that posts it after all cannot say so, and it is never handed over again.
      const late = await ackItem(item, 'posted-late');
      assert.deepEqual([late.status, late.body.code], [409, 'LEASE_LAPSED'], 'its lease lapsed; it is not told the answer was withdrawn');
      assert.equal((await claim()).body.items.some((i) => i.outboundId === item.outboundId), false);
    } finally {
      gateway._deps.now = realNow;
    }
  });

  it('closing a route does not unsend what was delivered', async () => {
    const accepted = await operatorSays(`m${++seq}`, '@nobody-by-that-name hello');
    const routeId = accepted.body.routeId;
    assert.equal(bridgeStore.routes.get(routeId).state, 'awaiting-master');
    // Its status or failure notices, if any were posted, are history.
    const text = 'Your message is waiting.';
    const id = bridgeStore.outbound.enqueue({ idemKey: `route:${routeId}:test-failure`, kind: 'failure', routeId, sourceLabel: 'TangleClaw', text, digest: bridgeStore.digest(text) }).outboundId;
    const item = (await claim()).body.items.find((i) => i.outboundId === id);
    assert.equal((await ackItem(item, `posted-${++seq}`)).status, 200);
    const closed = await masterWrites(routeId, 'close', { expectedVersion: bridgeStore.routes.get(routeId).version });
    assert.equal(closed.status, 200);
    assert.equal(bridgeStore.outbound.get(id).state, 'delivered');
  });

  it('the Master sees what was set aside and decides, over its own routes and with `tc bridge`', async () => {
    const make = (name) => {
      const text = `notice ${name}`;
      return bridgeStore.outbound.enqueue({
        idemKey: `notify:operator-needed:${name}-${++seq}`, kind: 'notification', notifyType: 'operator-needed', sourceLabel: 'TangleClaw', text, digest: bridgeStore.digest(text)
      }).outboundId;
    };
    const [a, b] = [make('a'), make('b')];
    const items = (await claim()).body.items;
    const report = (id, body) => call('POST', `/api/bridge/helper/outbound/${id}/failure`, { headers: asHelper(), body });
    const lease = (id) => items.find((i) => i.outboundId === id).leaseId;

    const unknown = await report(a, { leaseId: lease(a), reason: 'discard' });
    assert.deepEqual([unknown.status, unknown.body.code], [400, 'BAD_FAILURE'], 'the helper has no way to discard');
    assert.equal((await report(a, { leaseId: lease(a), reason: 'rejected-by-chat' }, asMaster())).status, 200);
    const part = await call('POST', `/api/bridge/helper/outbound/${b}/parts`, { headers: asHelper(), body: { leaseId: lease(b), partIndex: 0, partCount: 2, externalId: `p${++seq}x` } });
    assert.deepEqual([part.status, part.body.replayed], [200, false]);
    assert.equal((await report(b, { leaseId: lease(b), reason: 'part-conflict' })).body.state, 'blocked');
    for (const [method, apiPath] of [['POST', `/api/bridge/helper/outbound/${a}/failure`], ['POST', `/api/bridge/helper/outbound/${a}/parts`]]) {
      assert.equal((await call(method, apiPath, { headers: asMaster(), body: { leaseId: lease(a) } })).status, 401, 'the helper\'s routes are the helper\'s');
    }

    const blocked = await call('GET', '/api/bridge/master/outbound/blocked', { headers: asMaster() });
    const mine = blocked.body.items.filter((i) => [a, b].includes(i.outboundId));
    assert.deepEqual(mine.map((i) => [i.outboundId, i.notifyType, i.blockCode, i.attempts, i.partsPosted]),
      [[a, 'operator-needed', 'rejected-by-chat', 1, 0], [b, 'operator-needed', 'part-conflict', 1, 1]]);
    assert.ok(!JSON.stringify(blocked.body).includes('notice a'), 'what is set aside is listed without its text');

    const listed = await tc(['bridge', 'blocked']);
    assert.match(listed.stdout, new RegExp(`item ${a}  operator-needed  rejected-by-chat  handed over 1 time\\(s\\), 0 part\\(s\\) posted`));
    const back = await tc(['bridge', 'requeue', String(a)]);
    assert.deepEqual([back.code, back.stdout], [0, `Item ${a} is back in the mailbox for the helper.\n`]);
    assert.equal(bridgeStore.outbound.get(a).state, 'ready');
    const gone = await tc(['bridge', 'withdraw', String(b), '--request-id', 'req-withdraw-tc-0001']);
    assert.deepEqual([gone.code, gone.stdout], [0, `Item ${b} is withdrawn and will not be posted.\n`]);
    const again = await tc(['bridge', 'withdraw', String(b), '--request-id', 'req-withdraw-tc-0001']);
    assert.match(again.stdout, /already applied by an earlier use of this request id/);
    const refused = await tc(['bridge', 'requeue', String(b)]);
    assert.deepEqual([refused.code, /NOT_BLOCKED/.test(refused.stderr)], [2, true]);

    // The helper cannot make either decision, and neither can a session's or nobody's request.
    for (const headers of [asHelper(), {}]) {
      for (const what of ['requeue', 'withdraw']) {
        const r = await call('POST', `/api/bridge/master/outbound/${a}/${what}`, { headers, body: { requestId: `req-x-${++seq}-0000` } });
        assert.equal(r.status, 401, what);
      }
    }
    // The operator can, signed in.
    const again2 = (await claim()).body.items.find((i) => i.outboundId === a);
    await report(a, { leaseId: again2.leaseId, reason: 'rejected-by-chat' });
    const byOperator = await asOperator('POST', '/api/bridge/operator/outbound/:outboundId/withdraw', { params: { outboundId: String(a) }, body: { requestId: `req-op-${++seq}-0000` } });
    assert.deepEqual([byOperator.status, byOperator.body.item.state], [200, 'dropped']);
    const ambient = await bridgeApi.handle(bridgeApi.routeFor('POST', '/api/bridge/operator/outbound/:outboundId/requeue'),
      { req: AMBIENT, headers: AMBIENT.headers, params: { outboundId: String(a) }, body: { requestId: `req-op-${++seq}-0000` } });
    assert.equal(ambient.status, 403, 'a dashboard-shaped request on an open gate decides nothing');
  });

  it('a closed chat stops every claim over the route until the Master or the operator resets it', async () => {
    const text = 'notice for a closed chat';
    const id = bridgeStore.outbound.enqueue({
      idemKey: `notify:operator-needed:circuit-${++seq}`, kind: 'notification', notifyType: 'operator-needed', sourceLabel: 'TangleClaw', text, digest: bridgeStore.digest(text)
    }).outboundId;
    const item = (await claim()).body.items.find((i) => i.outboundId === id);
    const reported = await call('POST', `/api/bridge/helper/outbound/${id}/failure`, { headers: asHelper(), body: { leaseId: item.leaseId, reason: 'chat-channel-missing' } });
    assert.deepEqual([reported.status, reported.body.state, reported.body.circuit.opened], [200, 'blocked', true]);
    const episodeId = reported.body.circuit.episodeId;

    for (const headers of [asHelper(), asHelper()]) {
      const blocked = await claim(headers);
      assert.deepEqual([blocked.status, blocked.body.code, blocked.body.episodeId, blocked.body.reason], [409, 'BRIDGE_CONFIGURATION_BLOCKED', episodeId, 'chat-channel-missing']);
    }
    // The operator and the Master both see it where they look, with no chat needed to tell them.
    const forOperator = await asOperator('GET', '/api/bridge/operator/status');
    assert.deepEqual([forOperator.body.configurationCircuit.episodeId, forOperator.body.configurationCircuit.reason], [episodeId, 'chat-channel-missing']);
    const shown = await tc(['bridge', 'status']);
    assert.match(shown.stdout, new RegExp(`CONFIGURATION CIRCUIT OPEN, episode ${episodeId}, since .* \\(chat-channel-missing\\)`));
    assert.match(shown.stdout, new RegExp(`a release is not a delivery\\. You have not been told of it by message\\. NOT YET ACKNOWLEDGED: tell the operator, then \`tc bridge circuit ack ${episodeId}\``));

    // The Master takes it up. Nobody else can say it has.
    const ackAs = (headers) => call('POST', `/api/bridge/master/circuit/${episodeId}/ack`, { headers, body: {} });
    assert.equal((await ackAs(asHelper())).status, 401);
    assert.equal((await ackAs({})).status, 401);
    assert.equal(bridgeStore.circuit.open().masterAckedAt, null);
    const acked = await tc(['bridge', 'circuit', 'ack', String(episodeId)]);
    assert.deepEqual([acked.code, /^Configuration episode \d+ acknowledged\. It stays open until it is reset/.test(acked.stdout)], [0, true]);
    assert.match((await tc(['bridge', 'circuit', 'ack', String(episodeId)])).stdout, /\(it already was\)/);
    const wrong = await tc(['bridge', 'circuit', 'ack', String(episodeId + 50)]);
    assert.deepEqual([wrong.code, /CIRCUIT_NOT_OPEN/.test(wrong.stderr)], [2, true]);
    assert.match((await tc(['bridge', 'status'])).stdout, /Acknowledged 20\d\d-/);
    // The acknowledgement was that Master's. One launched since sees the
    // episode as its own to take up, is told so, and acknowledges for itself.
    const firstGeneration = masterGeneration;
    // The Master that acknowledged had been told. That telling was its own too.
    bridgeStore.circuit.noteMasterTold(episodeId, firstGeneration, { at: '2026-10-04T08:00:00.000Z' });
    assert.match((await tc(['bridge', 'status'])).stdout, /You were last told 2026-10-04T08:00:00\.000Z\. Acknowledged/);
    const relaunched = handoff.mintCredential();
    masterGeneration = bridgeStore.masterCredentials.mint(relaunched.hash);
    bridgeStore.masterCredentials.activate(masterGeneration, relaunched.hash);
    masterCredential = relaunched.credential;
    assert.match((await tc(['bridge', 'status'])).stdout, /You have not been told of it by message\. NOT YET ACKNOWLEDGED by you/, 'what its predecessor was told is not what it was told');
    bridgeStore.circuit.noteMasterTold(episodeId, masterGeneration, { at: '2026-10-04T09:00:00.000Z' });
    const successor = (await tc(['bridge', 'status'])).stdout;
    assert.match(successor, /You were last told 2026-10-04T09:00:00\.000Z\. NOT YET ACKNOWLEDGED by you \(an earlier Master did\): tell the operator/);
    assert.ok(!/Acknowledged 20/.test(successor));
    assert.match((await tc(['bridge', 'circuit', 'ack', String(episodeId)])).stdout, /^Configuration episode \d+ acknowledged\. It stays open/);
    assert.deepEqual([bridgeStore.circuit.open().masterAckedGeneration, masterGeneration > firstGeneration], [masterGeneration, true]);
    assert.match((await tc(['bridge', 'status'])).stdout, /You were last told 2026-10-04T09:00:00\.000Z\. Acknowledged 20\d\d-/);
    assert.equal((await claim()).body.code, 'BRIDGE_CONFIGURATION_BLOCKED', 'acknowledging it does not open the queue');

    // Only the Master or a signed-in operator resets it.
    const reset = (headers, body) => call('POST', '/api/bridge/master/circuit/reset', { headers, body });
    assert.equal((await reset(asHelper(), { requestId: `req-r-${++seq}-0000`, decision: 'requeue' })).status, 401);
    assert.equal((await reset({}, { requestId: `req-r-${++seq}-0000`, decision: 'requeue' })).status, 401);
    const ambient = await bridgeApi.handle(bridgeApi.routeFor('POST', '/api/bridge/operator/circuit/reset'),
      { req: AMBIENT, headers: AMBIENT.headers, params: {}, body: { requestId: `req-r-${++seq}-0000`, decision: 'requeue' } });
    assert.equal(ambient.status, 403);
    assert.equal((await reset(asMaster(), { requestId: `req-r-${++seq}-0000` })).body.code, 'DECISION_REQUIRED');
    assert.equal((await reset(asMaster(), { requestId: `req-r-${++seq}-0000`, decision: 'ignore' })).body.code, 'DECISION_REQUIRED');
    assert.equal(bridgeStore.circuit.open().episodeId, episodeId, 'none of those closed it');

    const usage = await tc(['bridge', 'reset']);
    assert.equal(usage.code, 1);
    const done = await tc(['bridge', 'reset', '--requeue']);
    assert.deepEqual([done.code, done.stdout], [0, `Configuration circuit reset: episode ${episodeId} is closed, 1 item(s) put back.\n`]);
    assert.equal(bridgeStore.circuit.open(), null);
    const again = (await claim()).body.items.find((i) => i.outboundId === id);
    assert.ok(again, 'and the item is handed over again');
    // The operator, signed in, has the same reset: a second episode, withdrawn this time.
    await call('POST', `/api/bridge/helper/outbound/${id}/failure`, { headers: asHelper(), body: { leaseId: again.leaseId, reason: 'chat-permission-denied' } });
    const second = bridgeStore.circuit.open().episodeId;
    assert.equal(second > episodeId, true);
    const byOperator = await asOperator('POST', '/api/bridge/operator/circuit/reset', { params: {}, body: { requestId: `req-r-${++seq}-0000`, decision: 'withdraw' } });
    assert.deepEqual([byOperator.status, byOperator.body.items, byOperator.body.episode.episodeId, byOperator.body.episode.closedBy, byOperator.body.episode.decision],
      [200, 1, second, 'operator', 'withdraw']);
    assert.deepEqual([bridgeStore.outbound.get(id).state, bridgeStore.outbound.get(id).dropCode], ['dropped', 'withdrawn']);
    const audited = store.getDb().prepare("SELECT proof, detail_json FROM bridge_audit WHERE op = 'circuit-reset' AND actor = 'operator' AND outcome = 'applied'").all();
    assert.deepEqual(audited.map((r) => [r.proof, JSON.parse(r.detail_json).user, JSON.parse(r.detail_json).episodeId]), [['verified-session', 'rosie', second]]);
    const none = await tc(['bridge', 'reset', '--withdraw']);
    assert.deepEqual([none.code, /CIRCUIT_NOT_OPEN/.test(none.stderr)], [2, true]);
    assert.doesNotMatch((await tc(['bridge', 'status'])).stdout, /CIRCUIT/);
  });

  it('refuses over the route, for good, an acknowledgement of an item that was let go, without saying what became of it', async () => {
    const realNow = gateway._deps.now;
    const week = bridgeStore.EXPIRY_MS.notification['operator-needed'];
    try {
      // A notification one minute short of its limit when the helper claims it.
      const created = new Date(Date.now() - week + 60000).toISOString();
      const text = 'A session needs the operator.';
      const id = bridgeStore.outbound.enqueue({
        idemKey: `notify:operator-needed:late-${++seq}`, kind: 'notification', notifyType: 'operator-needed', sourceLabel: 'TangleClaw',
        text, digest: bridgeStore.digest(text), at: created
      }).outboundId;
      const held = (await claim()).body.items.find((i) => i.outboundId === id);
      assert.equal(held.text, text);

      // Its lease lapses, the limit passes, and the next claim lets it go.
      const after = Date.now() + 60000 + bridgeStore.LEASE_MS + 1000;
      gateway._deps.now = () => new Date(after).toISOString();
      assert.equal((await claim()).body.items.some((i) => i.outboundId === id), false, 'it is not handed over again');
      assert.equal(bridgeStore.outbound.get(id).state, 'dropped');

      for (const attempt of [1, 2]) {
        const late = await ackItem(held, 'posted-late');
        assert.deepEqual([late.status, late.body.code], [409, 'LEASE_LAPSED'], `attempt ${attempt}`);
      }
      assert.deepEqual([bridgeStore.outbound.get(id).state, bridgeStore.outbound.get(id).deliveredRef], ['dropped', null]);
    } finally {
      gateway._deps.now = realNow;
    }
  });

  describe('asking the operator about a held message', () => {
    const HOUR = 60 * 60 * 1000;
    const version = (id) => bridgeStore.routes.get(id).version;
    const inbound = (id) => bridgeStore.routes.body(id, 'inbound');
    const questionRows = () => store.getDb().prepare('SELECT question_id, route_id, purpose, state, adopted_route_id, adopted_for FROM bridge_questions ORDER BY asked_at, question_id').all().map((r) => ({ ...r }));
    /** The questions asked about one held message, oldest first. The store is one for this whole file. */
    const questionsOf = (routeId) => questionRows().filter((q) => q.route_id === routeId);
    /** What the helper was handed for one held message: an item names the message it is posted in reply to, never the route. */
    const about = (items, routeId) => items.filter((i) => i.inReplyTo && i.inReplyTo.externalId === bridgeStore.routes.get(routeId).externalId);
    /**
     * Everything that waits, collected as the helper would over several passes. One claim hands over at most 20
     * items, and this file's one store still holds what earlier tests left unposted.
     */
    const claimAll = async () => {
      const all = [];
      for (let pass = 0; pass < 10; pass++) {
        const { items } = (await claim()).body;
        if (!items.length) break;
        all.push(...items);
      }
      return all;
    };
    /** Everything a refused write must leave exactly as it was. */
    const everything = (...routeIds) => JSON.stringify([
      routeIds.map((id) => [bridgeStore.routes.get(id), bridgeStore.routes.body(id, 'inbound')]),
      questionRows(), store.getDb().prepare('SELECT outbound_id, kind, state, text FROM bridge_outbound ORDER BY outbound_id').all().map((r) => ({ ...r })),
      hub.fromGateway().length
    ]);
    /** The operator writes something nobody can place, so it waits with no suggestion. */
    const held = async (text = '@nobody-by-that-name can you look at the build?') => {
      const accepted = await operatorWrites(`m${++seq}`, text);
      assert.equal(accepted.status, 202);
      assert.equal(bridgeStore.routes.get(accepted.body.routeId).state, 'awaiting-master');
      return accepted.body.routeId;
    };
    /** The Master asks, the helper posts the question, and the chat's id for the post is returned. */
    const askedAndPosted = async (routeId, text = 'Which project did you mean?') => {
      const asked = await masterWrites(routeId, 'ask', { expectedVersion: version(routeId), text });
      assert.equal(asked.status, 200, JSON.stringify(asked.body));
      const items = about((await claimAll()), routeId).filter((i) => i.kind === 'question');
      assert.equal(items.length, 1);
      const posted = `dq${++seq}`;
      assert.equal((await ackItem(items[0], posted)).status, 200);
      return posted;
    };
    /** The operator replies in the chat to a posted message. */
    const operatorReplies = async (to, text) => {
      const res = await call('POST', '/api/bridge/helper/inbound', { headers: asHelper(), body: { externalId: `m${++seq}`, ...ALLOWED, replyToExternalId: to, text } });
      assert.equal(res.status, 202, JSON.stringify(res.body));
      return res.body.routeId;
    };
    /**
     * Run `fn` with the gateway's clock `ms` after the newest question of this test was asked. Questions an earlier
     * test asked under a clock it had moved on are in the future and are not the base.
     */
    const later = async (ms, fn) => {
      const realNow = gateway._deps.now;
      const asked = store.getDb().prepare('SELECT MAX(asked_at) AS at FROM bridge_questions WHERE asked_at <= ?').get(realNow()).at;
      const at = new Date(Date.parse(asked) + ms).toISOString();
      gateway._deps.now = () => at;
      try { return await fn(); } finally { gateway._deps.now = realNow; }
    };

    it('a question goes to the operator as a reply to their message, and the message stays held with nothing sent on', async () => {
      const routeId = await held();
      const before = bridgeStore.routes.get(routeId);
      const asked = await masterWrites(routeId, 'ask', { expectedVersion: before.version, text: 'Which project did you mean?' });
      assert.deepEqual([asked.status, asked.body.route.state, asked.body.route.version], [200, 'awaiting-master', before.version + 1]);
      assert.equal(asked.body.route.destination, null, 'asking decides nothing about where it goes');
      assert.equal(inbound(routeId).text, '@nobody-by-that-name can you look at the build?', 'the original is held, word for word');
      assert.deepEqual(hub.fromGateway(), [], 'and nothing was sent to any session');
      const [question] = questionsOf(routeId);
      assert.deepEqual([question.route_id, question.purpose, question.state], [routeId, 'clarify', 'open']);

      const items = about((await claimAll()), routeId);
      assert.deepEqual(items.map((i) => [i.kind, i.text, i.sourceLabel]), [['question', 'Which project did you mean?', 'Project Master']]);
      assert.equal(items[0].inReplyTo.externalId, before.externalId, 'posted as a reply to the message it asks about');
      assert.equal((await ackItem(items[0], 'dq-first')).status, 200);
      assert.equal(bridgeStore.routes.get(routeId).state, 'awaiting-master', 'a delivered question closes nothing and releases nothing');
      assert.equal(inbound(routeId).text, '@nobody-by-that-name can you look at the build?');

      const read = await call('GET', `/api/bridge/master/routes/${routeId}`, { headers: asMaster() });
      assert.deepEqual([read.body.route.openQuestion.questionId, read.body.route.openQuestion.purpose], [question.question_id, 'clarify']);
      assert.equal(Date.parse(read.body.route.openQuestion.expiresAt) - Date.parse(read.body.route.openQuestion.askedAt), 24 * HOUR);
      const audit = store.getDb().prepare("SELECT outcome, detail_json FROM bridge_audit WHERE op = 'ask' AND route_id = ?").get(routeId);
      assert.equal(audit.outcome, 'applied');
      assert.ok(!audit.detail_json.includes('Which project'), 'the audit names the question, and carries none of its words');
    });

    it('one question at a time, only about a message still waiting, and only with something to ask', async () => {
      const routeId = await held();
      await askedAndPosted(routeId);
      let before = everything(routeId);
      const second = await masterWrites(routeId, 'ask', { expectedVersion: version(routeId), text: 'And when?' });
      assert.deepEqual([second.status, second.body.code], [409, 'QUESTION_OPEN']);
      assert.equal(everything(routeId), before);
      for (const [text, status, code] of [['', 400, 'QUESTION_REQUIRED'], ['   ', 400, 'QUESTION_REQUIRED'], [undefined, 400, 'QUESTION_REQUIRED'], ['x'.repeat(8001), 413, 'QUESTION_TOO_LONG'], ['left‮right', 400, 'QUESTION_NOT_DISPLAY_SAFE']]) {
        const res = await masterWrites(routeId, 'ask', { expectedVersion: version(routeId), text });
        assert.deepEqual([res.status, res.body.code], [status, code], JSON.stringify(text && text.slice(0, 12)));
      }
      assert.equal(everything(routeId), before);
      // A message already on its way is past asking about.
      const alpha = liveProject(`Alpha${++seq}`);
      const routed = (await operatorSays(`m${++seq}`, `@${alpha.project.name} status?`)).body.routeId;
      before = everything(routed);
      const late = await masterWrites(routed, 'ask', { expectedVersion: version(routed), text: 'Sure?' });
      assert.deepEqual([late.status, late.body.code], [409, 'NOT_AWAITING_MASTER']);
      assert.equal(everything(routed), before);
    });

    it('the operator\'s reply to the question, adopted, routes the original unchanged and is used once', async () => {
      const alpha = liveProject(`Alpha${++seq}`);
      const routeId = await held();
      const posted = await askedAndPosted(routeId);
      const reply = await operatorReplies(posted, `I meant ${alpha.project.name}`);
      const replyRoute = bridgeStore.routes.get(reply);
      assert.equal(replyRoute.state, 'awaiting-master', 'the reply is itself held: it routes nothing by arriving');
      assert.deepEqual(bridgeStore.audit.suggestionFor(reply), { by: 'question-answer', to: 'master', projectId: null, reason: null }, 'and is shown to the Master as an answer to its question');
      assert.deepEqual([replyRoute.replyContext.kind, replyRoute.replyContext.routeId, replyRoute.replyContext.questionId], ['question', routeId, questionsOf(routeId)[0].question_id]);
      assert.deepEqual(hub.fromGateway(), [], 'nothing has been sent yet');

      const routed = await masterWrites(routeId, 'route', { expectedVersion: version(routeId), to: alpha.project.id, answeredBy: reply });
      assert.deepEqual([routed.status, routed.body.route.state], [200, 'routed'], JSON.stringify(routed.body));
      const sent = hub.fromGateway();
      assert.equal(sent.length, 1);
      assert.equal(sent[0].to, alpha.workspaceId);
      assert.ok(sent[0].message.includes('@nobody-by-that-name can you look at the build?'), 'what is sent is the original message, not the reply and not a retyping');
      assert.ok(!sent[0].message.includes('I meant'), 'the reply itself is sent nowhere');
      assert.deepEqual(questionsOf(routeId).map((q) => [q.state, q.adopted_route_id, q.adopted_for]), [['adopted', reply, 'route']]);
      const closed = bridgeStore.routes.get(reply);
      assert.deepEqual([closed.state, closed.closedBy], ['closed', 'master'], 'the reply\'s own route is closed by the same write');
      assert.equal(inbound(reply).text, null, 'and its text is cleared');
      const trail = store.getDb().prepare("SELECT op, route_id, outcome, detail_json FROM bridge_audit WHERE op IN ('route','adopted') AND route_id IN (?, ?) ORDER BY audit_seq").all(routeId, reply);
      assert.deepEqual(trail.map((r) => [r.op, r.route_id, r.outcome]), [['adopted', reply, 'applied'], ['route', routeId, 'applied']], 'each route\'s record says what became of it');
      assert.ok(trail.every((r) => !/I meant|look at the build/.test(r.detail_json)), 'both audit rows are ids only');
      assert.deepEqual([JSON.parse(trail[0].detail_json).heldRouteId, JSON.parse(trail[1].detail_json).replyRouteId], [routeId, reply], 'and each names the other');
    });

    it('nothing but a recorded reply to that very question is taken as its answer', async () => {
      const alpha = liveProject(`Alpha${++seq}`);
      const routeId = await held();
      const posted = await askedAndPosted(routeId);
      const other = await held('@another-unknown and this one?');
      const otherPosted = await askedAndPosted(other, 'Which one?');
      const refusedWith = async (answeredBy, status, code, why) => {
        const involved = [routeId, other, ...(typeof answeredBy === 'string' && bridgeStore.routes.get(answeredBy) ? [answeredBy] : [])];
        const before = everything(...involved);
        const res = await masterWrites(routeId, 'route', { expectedVersion: version(routeId), to: alpha.project.id, answeredBy });
        assert.deepEqual([res.status, res.body.code], [status, code], why);
        assert.equal(everything(...involved), before, `${why}: nothing moved, and nothing was sent`);
      };
      // A new message that says yes, but replies to nothing.
      const unrelated = (await operatorWrites(`m${++seq}`, `yes, ${alpha.project.name}`)).body.routeId;
      await refusedWith(unrelated, 409, 'NOT_AN_ANSWER', 'a message that is not a reply');
      // A reply, but to the question asked about a different message.
      const crossed = await operatorReplies(otherPosted, `yes, ${alpha.project.name}`);
      await refusedWith(crossed, 409, 'NOT_AN_ANSWER', 'a reply to another message\'s question');
      // A reply to the operator's own original, not to the question.
      const toOriginal = await operatorReplies(bridgeStore.routes.get(routeId).externalId, 'any news?');
      await refusedWith(toOriginal, 409, 'NOT_AN_ANSWER', 'a reply to the original message');
      await refusedWith(routeId, 409, 'NOT_AN_ANSWER', 'the held message itself');
      await refusedWith('rt_no_such_route', 409, 'NOT_AN_ANSWER', 'a route that does not exist');
      for (const bad of ['', 'has spaces', 42, null, 'x'.repeat(65)]) await refusedWith(bad, 400, 'BAD_ANSWERED_BY', `answeredBy ${JSON.stringify(bad)}`);

      // A reply to the question that the Master has already routed somewhere as a message of its own is no longer held.
      const spent = await operatorReplies(posted, 'tell the Master instead');
      assert.equal((await masterWrites(spent, 'route', { expectedVersion: version(spent), to: 'master' })).status, 200);
      await refusedWith(spent, 409, 'REPLY_NOT_HELD', 'a reply already routed as a message in its own right');
      // The real answer, once: a second reply to the same question finds it settled.
      const answer = await operatorReplies(posted, 'the first one');
      const again = await operatorReplies(posted, 'yes, really');
      const routedOnce = await masterWrites(routeId, 'route', { expectedVersion: version(routeId), to: 'master', answeredBy: answer });
      assert.equal(routedOnce.status, 200, JSON.stringify(routedOnce.body));
      assert.equal(hub.fromGateway().length, 0, 'routed to the Master itself: nothing goes to a session');
      const reused = await masterWrites(other, 'route', { expectedVersion: version(other), to: 'master', answeredBy: answer });
      assert.deepEqual([reused.status, reused.body.code], [409, 'NOT_AN_ANSWER'], 'an answer already used answers nothing else');
      const dup = await masterWrites(other, 'route', { expectedVersion: version(other), to: 'master', answeredBy: again });
      assert.deepEqual([dup.status, dup.body.code], [409, 'NOT_AN_ANSWER'], 'nor does a second reply to the first question answer the second');
      assert.equal(bridgeStore.routes.get(again).state, 'awaiting-master', 'the duplicate is left for the Master to close');
    });

    it('an answer is not adopted while the helper is posting something about it, and is once that has settled', async () => {
      const routeId = await held();
      const posted = await askedAndPosted(routeId);
      const reply = await operatorReplies(posted, 'the Master');
      // Five minutes on, the reply's own "still waiting" notice is in the helper's hands.
      await later(6 * 60 * 1000, async () => {
        await gateway.tick();
        const handed = about(await claimAll(), reply);
        assert.deepEqual(handed.map((i) => i.kind), ['status']);
        const before = everything(routeId, reply);
        const res = await masterWrites(routeId, 'route', { expectedVersion: version(routeId), to: 'master', answeredBy: reply });
        assert.deepEqual([res.status, res.body.code], [409, 'OUTBOUND_IN_FLIGHT'], 'closing the reply would withdraw what is being posted');
        assert.equal(everything(routeId, reply), before);
        assert.equal(questionsOf(routeId)[0].state, 'open', 'the question is still open, and the answer still usable');
      });
      await later(6 * 60 * 1000 + bridgeStore.LEASE_MS + 1000, async () => {
        const res = await masterWrites(routeId, 'route', { expectedVersion: version(routeId), to: 'master', answeredBy: reply });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.deepEqual([bridgeStore.routes.get(reply).state, questionsOf(routeId)[0].state], ['closed', 'adopted']);
        assert.deepEqual(store.getDb().prepare("SELECT state, drop_code FROM bridge_outbound WHERE route_id = ? AND kind = 'status'").all(reply).map((r) => [r.state, r.drop_code]), [['dropped', 'withdrawn']], 'its unposted notice goes with it');
      });
    });

    it('an unanswered question runs out: nothing is routed, the message stays held, and the operator is told in fixed words', async () => {
      const alpha = liveProject(`Alpha${++seq}`);
      const routeId = await held();
      const posted = await askedAndPosted(routeId);
      const heldVersion = version(routeId);
      // Out of time by the clock, before the gateway's pass has marked it: already unusable.
      const lateReply = await operatorReplies(posted, alpha.project.name);
      await later(24 * HOUR, async () => {
        const before = everything(routeId, lateReply);
        const res = await masterWrites(routeId, 'route', { expectedVersion: version(routeId), to: alpha.project.id, answeredBy: lateReply });
        assert.deepEqual([res.status, res.body.code], [409, 'QUESTION_EXPIRED']);
        assert.equal(everything(routeId, lateReply), before);
      });
      await later(24 * HOUR - 1, async () => {
        await gateway.tick();
        assert.equal(questionsOf(routeId)[0].state, 'open', 'one millisecond inside its time it is still open');
      });
      await later(24 * HOUR, async () => {
        await gateway.tick();
        assert.equal(questionsOf(routeId)[0].state, 'expired');
        const route = bridgeStore.routes.get(routeId);
        assert.deepEqual([route.state, route.destination], ['awaiting-master', null], 'the message is not closed and not routed');
        assert.equal(route.version, heldVersion + 1, 'its version moved, so the Master is told');
        assert.equal(inbound(routeId).text, '@nobody-by-that-name can you look at the build?', 'and its text is still held');
        assert.deepEqual(hub.fromGateway().filter((m) => m.to === alpha.workspaceId), [], 'nothing was sent to the project');
        const notices = about((await claimAll()), routeId);
        assert.deepEqual(notices.filter((i) => i.kind === 'failure').map((i) => i.text), [bridgeStore.QUESTION_EXPIRED_TEXT.clarify]);
        const audit = store.getDb().prepare("SELECT outcome, detail_json FROM bridge_audit WHERE op = 'expire' AND route_id = ?").get(routeId);
        assert.deepEqual([audit.outcome, JSON.parse(audit.detail_json).what], ['unanswered-expired', 'question']);
        // The late reply is no answer now either, and says so differently: the question is settled.
        const res = await masterWrites(routeId, 'route', { expectedVersion: version(routeId), to: alpha.project.id, answeredBy: lateReply });
        assert.deepEqual([res.status, res.body.code], [409, 'QUESTION_SETTLED']);
        await gateway.tick();
        assert.equal(store.getDb().prepare("SELECT COUNT(*) AS n FROM bridge_outbound WHERE kind = 'failure' AND route_id = ?").get(routeId).n, 1, 'told once');
        // The Master may ask again, or route it on its own reading.
        const asked = await masterWrites(routeId, 'ask', { expectedVersion: version(routeId), text: 'Still want this?' });
        assert.equal(asked.status, 200);
      });
    });

    it('a question never posted is not posted once it has run out, and the operator is not told of a question they never saw', async () => {
      const routeId = await held();
      assert.equal((await masterWrites(routeId, 'ask', { expectedVersion: version(routeId), text: 'Which?' })).status, 200);
      await later(24 * HOUR, async () => {
        await gateway.tick();
        assert.equal(questionsOf(routeId)[0].state, 'expired');
        const items = about((await claimAll()), routeId);
        assert.deepEqual(items.map((i) => i.kind).sort(), ['status'], 'no question, and no notice about one: only the ordinary still-waiting notice, which nothing now stands in for');
        assert.deepEqual(store.getDb().prepare("SELECT state, drop_code, text FROM bridge_outbound WHERE kind = 'question' AND route_id = ?").all(routeId).map((r) => [r.state, r.drop_code, r.text]), [['dropped', 'withdrawn', null]]);
        const audit = store.getDb().prepare("SELECT detail_json FROM bridge_audit WHERE op = 'expire' AND route_id = ?").get(routeId);
        assert.equal(JSON.parse(audit.detail_json).operatorTold, false, 'and the audit says the operator was not told');
      });
    });

    it('the Master going away and coming back changes nothing about a question that is open', async () => {
      const alpha = liveProject(`Alpha${++seq}`);
      const routeId = await held();
      const posted = await askedAndPosted(routeId);
      const live = gateway._deps.master;
      gateway._deps.master = () => ({ ...live(), masterLiveness: () => ({ live: false, answered: true }), ensureMasterSession: () => ({ created: false, error: 'tmux did not answer' }) });
      await gateway.tick();
      assert.equal(bridgeStore.routes.get(routeId).state, 'queued-master-unavailable', 'the message is queued while the Master is away');
      assert.equal(questionsOf(routeId)[0].state, 'open', 'and is still held: what was asked about it stands');
      // The operator answers while the Master is away.
      const reply = await operatorReplies(posted, alpha.project.name);
      gateway._deps.master = live;
      await later(60 * 1000, async () => {
        await gateway.tick();
        assert.equal(bridgeStore.routes.get(routeId).state, 'awaiting-master');
        assert.equal(questionsOf(routeId)[0].state, 'open');
        const routed = await masterWrites(routeId, 'route', { expectedVersion: version(routeId), to: alpha.project.id, answeredBy: reply });
        assert.deepEqual([routed.status, routed.body.route.state], [200, 'routed'], JSON.stringify(routed.body));
        assert.deepEqual(questionsOf(routeId).map((q) => [q.state, q.adopted_route_id]), [['adopted', reply]]);
      });
    });

    it('a reply that was itself asked about takes that question with it when it is adopted', async () => {
      const routeId = await held();
      const posted = await askedAndPosted(routeId);
      const reply = await operatorReplies(posted, 'the usual one');
      // The Master asks what "the usual one" means, then routes the original on its own reading of the first answer.
      const second = await askedAndPosted(reply, 'Which is the usual one?');
      const routed = await masterWrites(routeId, 'route', { expectedVersion: version(routeId), to: 'master', answeredBy: reply });
      assert.equal(routed.status, 200, JSON.stringify(routed.body));
      assert.equal(bridgeStore.routes.get(reply).state, 'closed');
      assert.deepEqual(questionsOf(reply).map((q) => q.state), ['cancelled'], 'nothing is left open about a closed message');
      const late = await operatorReplies(second, 'never mind');
      await later(25 * HOUR, async () => {
        await gateway.tick();
        assert.equal(store.getDb().prepare("SELECT COUNT(*) AS n FROM bridge_outbound WHERE kind = 'failure' AND route_id = ?").get(reply).n, 0, 'and the operator is never told a closed message is still held');
        assert.deepEqual(questionsOf(reply).map((q) => q.state), ['cancelled']);
      });
      assert.equal(bridgeStore.routes.get(late).state, 'awaiting-master');
    });

    it('a question not yet posted is not posted once the message has been decided, and not ended while the helper is posting it', async () => {
      const first = await held();
      assert.equal((await masterWrites(first, 'ask', { expectedVersion: version(first), text: 'Which?' })).status, 200);
      const routed = await masterWrites(first, 'route', { expectedVersion: version(first), to: 'master' });
      assert.equal(routed.status, 200, JSON.stringify(routed.body));
      assert.equal(questionsOf(first)[0].state, 'cancelled');
      assert.deepEqual(about(await claimAll(), first).filter((i) => i.kind === 'question'), [], 'the question is never put to the operator');
      assert.deepEqual(store.getDb().prepare("SELECT state, drop_code FROM bridge_outbound WHERE kind = 'question' AND route_id = ?").all(first).map((r) => [r.state, r.drop_code]), [['dropped', 'withdrawn']]);

      const second = await held('@nobody-again and this?');
      assert.equal((await masterWrites(second, 'ask', { expectedVersion: version(second), text: 'Who?' })).status, 200);
      const handed = about(await claimAll(), second);
      assert.deepEqual(handed.map((i) => i.kind), ['question'], 'the helper has the question and may be posting it');
      const before = everything(second);
      const refused = await masterWrites(second, 'route', { expectedVersion: version(second), to: 'master' });
      assert.deepEqual([refused.status, refused.body.code], [409, 'OUTBOUND_IN_FLIGHT']);
      assert.equal(everything(second), before, 'nothing moved: the question is still open and the message still held');
      assert.equal((await ackItem(handed[0], `dq${++seq}`)).status, 200);
      assert.equal((await masterWrites(second, 'route', { expectedVersion: version(second), to: 'master' })).status, 200, 'once it is posted the Master may decide');
    });

    it('withdrawing a question\'s text ends the question, and the message can be asked about again', async () => {
      const routeId = await held();
      assert.equal((await masterWrites(routeId, 'ask', { expectedVersion: version(routeId), text: 'Which?' })).status, 200);
      const item = store.getDb().prepare("SELECT outbound_id FROM bridge_outbound WHERE kind = 'question' AND route_id = ?").get(routeId).outbound_id;
      const withdrawn = await call('POST', `/api/bridge/master/outbound/${item}/withdraw`, { headers: asMaster(), body: { requestId: `req-wd-${++seq}-0000` } });
      assert.equal(withdrawn.status, 200, JSON.stringify(withdrawn.body));
      assert.deepEqual(questionsOf(routeId).map((q) => q.state), ['cancelled'], 'a question that will never be posted cannot be answered');
      assert.equal(bridgeStore.routes.get(routeId).state, 'awaiting-master', 'the message itself is untouched');
      const again = await masterWrites(routeId, 'ask', { expectedVersion: version(routeId), text: 'Which project?' });
      assert.equal(again.status, 200, JSON.stringify(again.body));
      // A question that ended this way stands in for no notice: the ordinary still-waiting notice still goes.
      const other = await held('@nobody-here either');
      assert.equal((await masterWrites(other, 'ask', { expectedVersion: version(other), text: 'Who?' })).status, 200);
      const otherItem = store.getDb().prepare("SELECT outbound_id FROM bridge_outbound WHERE kind = 'question' AND route_id = ?").get(other).outbound_id;
      assert.equal((await call('POST', `/api/bridge/master/outbound/${otherItem}/withdraw`, { headers: asMaster(), body: { requestId: `req-wd-${++seq}-0000` } })).status, 200);
      await later(6 * 60 * 1000, async () => {
        await gateway.tick();
        assert.equal(store.getDb().prepare("SELECT COUNT(*) AS n FROM bridge_outbound WHERE kind = 'status' AND route_id = ?").get(other).n, 1);
      });
    });

    it('an adoption under the longest request id the bridge accepts is applied', async () => {
      const routeId = await held();
      const posted = await askedAndPosted(routeId);
      const reply = await operatorReplies(posted, 'the Master');
      const res = await call('POST', `/api/bridge/master/routes/${routeId}/route`, { headers: asMaster(), body: { requestId: 'r'.repeat(128), expectedVersion: version(routeId), to: 'master', answeredBy: reply } });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(bridgeStore.routes.get(reply).state, 'closed');
    });

    it('routing or closing the message on the Master\'s own reading ends the question', async () => {
      const alpha = liveProject(`Alpha${++seq}`);
      const first = await held();
      const posted = await askedAndPosted(first);
      const routed = await masterWrites(first, 'route', { expectedVersion: version(first), to: alpha.project.id });
      assert.deepEqual([routed.status, routed.body.route.state], [200, 'routed'], 'the Master may decide without waiting for the answer');
      assert.equal(questionsOf(first)[0].state, 'cancelled');
      // An answer that arrives afterwards answers nothing.
      const tooLate = await operatorReplies(posted, 'never mind');
      assert.equal(bridgeStore.routes.get(tooLate).state, 'awaiting-master');

      const second = await held('@still-nobody and this?');
      assert.equal((await masterWrites(second, 'ask', { expectedVersion: version(second), text: 'Who?' })).status, 200);
      const closed = await masterWrites(second, 'close', { expectedVersion: version(second) });
      assert.equal(closed.body.route.state, 'closed');
      assert.deepEqual(questionsOf(second).map((q) => q.state), ['cancelled']);
      assert.deepEqual(about((await claimAll()), second).filter((i) => i.kind === 'question'), [], 'and its unposted question is withdrawn with it');
    });

    it('the operator is not told a message is still waiting while they have been asked about it', async () => {
      const asked = await held();
      const plain = await held('@nobody-either hello?');
      await askedAndPosted(asked);
      const statuses = () => store.getDb().prepare("SELECT route_id FROM bridge_outbound WHERE kind = 'status' AND route_id IN (?, ?)").all(asked, plain).map((r) => r.route_id);
      await later(6 * 60 * 1000, async () => {
        await gateway.tick();
        assert.deepEqual(statuses(), [plain], 'only the message nobody has asked about gets the notice');
      });
      // Nor once the question has run out: the notice of that already says the message is still held.
      await later(25 * HOUR, async () => {
        await gateway.tick();
        assert.deepEqual(statuses(), [plain]);
        assert.equal(store.getDb().prepare("SELECT COUNT(*) AS n FROM bridge_outbound WHERE kind = 'failure' AND route_id = ?").get(asked).n, 1, 'told once, in the words for a question that ran out');
      });
    });

    it('`tc bridge ask` and `tc bridge route --answered-by` do the same over the command line, and show what was asked', async () => {
      const routeId = await held();
      const asked = await tc(['bridge', 'ask', routeId, '--version', String(version(routeId)), '--text', 'Which project did you mean?']);
      assert.equal(asked.code, 0, asked.stderr);
      assert.match(asked.stdout, new RegExp(`Your question about route ${routeId} is on its way to the operator; the message stays held and nothing else is sent; now v\\d+\\.`));
      const read = await tc(['bridge', 'read', routeId]);
      assert.match(read.stdout, /you asked the operator a question about it \(q_[A-Za-z0-9_-]+, [0-9T:.Z-]+\); it can be answered until [0-9T:.Z-]+/);
      const items = about((await claimAll()), routeId).filter((i) => i.kind === 'question');
      assert.equal((await ackItem(items[0], 'dq-cli')).status, 200);
      const reply = await operatorReplies('dq-cli', 'the Master itself');
      const listed = await tc(['bridge', 'read', reply]);
      assert.match(listed.stdout, new RegExp(`answers posted question of route ${routeId}`), 'the reply is shown as an answer to that question');
      const wrong = await tc(['bridge', 'answer', routeId, '--version', String(version(routeId)), '--text', 'x', '--answered-by', reply]);
      assert.deepEqual([wrong.code, /unexpected --answered-by/.test(wrong.stderr)], [1, true], 'only a route write takes an answer');
      const routed = await tc(['bridge', 'route', routeId, '--version', String(version(routeId)), '--to', 'master', '--answered-by', reply]);
      assert.equal(routed.code, 0, routed.stderr);
      assert.equal(bridgeStore.routes.get(reply).state, 'closed');
      const second = await tc(['bridge', 'ask', routeId, '--version', String(version(routeId)), '--text', 'Again?']);
      assert.deepEqual([second.code, /refused \[NOT_AWAITING_MASTER\]/.test(second.stderr)], [2, true]);
    });
  });

  describe('launching a stopped project, on the operator\'s consent and nothing less', () => {
    const MIN = 60 * 1000;
    const version = (id) => bridgeStore.routes.get(id).version;
    const db = () => store.getDb();
    const launchOf = (routeId) => bridgeStore.launches.latestFor(routeId);
    const questionOf = (routeId) => ({ ...db().prepare('SELECT question_id, purpose, target_project_id, state, adopted_route_id, adopted_for, asked_at, expires_at FROM bridge_questions WHERE route_id = ? ORDER BY asked_at DESC, question_id DESC LIMIT 1').get(routeId) });
    const sentTo = (workspaceId) => hub.fromGateway().filter((m) => m.to === workspaceId);
    const about = (items, routeId) => items.filter((i) => i.inReplyTo && i.inReplyTo.externalId === bridgeStore.routes.get(routeId).externalId);
    const claimAll = async () => {
      const all = [];
      for (let pass = 0; pass < 10; pass++) {
        const { items } = (await claim()).body;
        if (!items.length) break;
        all.push(...items);
      }
      return all;
    };
    let launched;
    let realLaunch;
    let realWarm;
    let realSessions;
    let realControl;
    let launchBehaviour;
    /** When set, the warm-up before a launch waits on this promise, as a slow network would make it. */
    let warming;

    beforeEach(() => {
      // One launch is in flight on the install at a time, and this file has one store: what an earlier test left
      // unsettled would hold up every launch after it.
      for (const left of bridgeStore.launches.unsettled()) bridgeStore.launches.end(left.launchSeq, 'abandoned', 'test-reset', new Date().toISOString());
      launched = [];
      launchBehaviour = null;
      warming = null;
      realLaunch = gateway._deps.launchSession;
      realWarm = gateway._deps.warmForLaunch;
      realSessions = gateway._deps.sessions;
      realControl = gateway._deps.controlState;
      gateway._deps.warmForLaunch = async () => { if (warming) await warming; };
      // The server's launch, stood in for: a session row, its launch sequence and its listener, as a real launch
      // leaves them. Synchronous, as the real one is.
      gateway._deps.launchSession = (...args) => {
        launched.push(args);
        if (launchBehaviour) return launchBehaviour(...args);
        const session = hub.anotherSession(args[0]);
        db().prepare("UPDATE launch_sequences SET applicability = 'applicable' WHERE session_id = ?").run(session.sessionId);
        // The shape `sessions.launchSession` really answers with: the session row under `session`.
        return { session: store.sessions.getActive(args[0].id), primePrompt: null, ttydUrl: null, error: null };
      };
    });

    // Restored by the file's own `beforeEach` for `gateway._deps.master`; these three are this suite's.
    const restore = () => Object.assign(gateway._deps, { launchSession: realLaunch, warmForLaunch: realWarm, sessions: realSessions, controlState: realControl });

    /** A project that exists and is not running. */
    const stopped = () => store.projects.create({ name: `Stopped${++seq}`, path: path.join(tmpDir, `Stopped${seq}`) });
    /** The session a launch waits for says it is READY, as `tc start ready` records it. */
    const becomesReady = (sessionId) => db().prepare("UPDATE launch_sequences SET ready_at = datetime('now'), ready_artifact = 'attested', ready_digest = ? WHERE session_id = ?").run('d'.repeat(64), sessionId);
    /** A message for a stopped project, held; the Master has asked whether to launch, and the question is posted. */
    const asked = async (project = stopped()) => {
      const accepted = await operatorWrites(`m${++seq}`, `@${project.name} please run the nightly`);
      const routeId = accepted.body.routeId;
      assert.equal(bridgeStore.routes.get(routeId).state, 'awaiting-master');
      const res = await masterWrites(routeId, 'ask-launch', { expectedVersion: version(routeId), project: project.id });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const items = about(await claimAll(), routeId).filter((i) => i.kind === 'question');
      assert.equal(items.length, 1);
      const posted = `dl${++seq}`;
      assert.equal((await ackItem(items[0], posted)).status, 200);
      return { project, routeId, posted, question: items[0] };
    };
    const operatorReplies = async (to, text) => {
      const res = await call('POST', '/api/bridge/helper/inbound', { headers: asHelper(), body: { externalId: `m${++seq}`, ...ALLOWED, replyToExternalId: to, text } });
      assert.equal(res.status, 202, JSON.stringify(res.body));
      return res.body.routeId;
    };
    /** Asked, answered yes, and the Master has adopted that answer as consent. */
    const consented = async (project) => {
      const a = await asked(project);
      const reply = await operatorReplies(a.posted, 'yes');
      const res = await masterWrites(a.routeId, 'launch', { expectedVersion: version(a.routeId), answeredBy: reply });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      return { ...a, reply };
    };
    /** Run `fn` with the gateway's clock `ms` past the real one. */
    const later = async (ms, fn) => {
      const realNow = gateway._deps.now;
      const at = new Date(Date.parse(realNow()) + ms).toISOString();
      gateway._deps.now = () => at;
      try { return await fn(); } finally { gateway._deps.now = realNow; }
    };

    it('routing to a project that is not running is refused, the message stays held, and nothing is launched', async () => {
      try {
        const project = stopped();
        const routeId = (await operatorWrites(`m${++seq}`, `@${project.name} hello`)).body.routeId;
        const before = JSON.stringify(bridgeStore.routes.get(routeId));
        const res = await masterWrites(routeId, 'route', { expectedVersion: version(routeId), to: project.id });
        assert.deepEqual([res.status, res.body.code], [409, 'TARGET_OFFLINE']);
        assert.equal(JSON.stringify(bridgeStore.routes.get(routeId)), before);
        await gateway.tick();
        assert.deepEqual(launched, [], 'routing launches nothing');
        assert.equal(store.sessions.getActive(project.id), null);
      } finally { restore(); }
    });

    it('asking launches nothing: the question is the server\'s fixed sentence, answerable for an hour', async () => {
      try {
        const a = await asked();
        assert.equal(a.question.text, `${a.project.name} is not running. Would you like me to launch it?`);
        const q = questionOf(a.routeId);
        assert.deepEqual([q.purpose, q.target_project_id, q.state], ['launch', a.project.id, 'open']);
        assert.equal(Date.parse(q.expires_at) - Date.parse(q.asked_at), 60 * MIN);
        for (let i = 0; i < 3; i++) await gateway.tick();
        assert.deepEqual(launched, [], 'no launch before consent, however many passes run');
        assert.equal(launchOf(a.routeId), null);
        assert.equal(bridgeStore.routes.get(a.routeId).state, 'awaiting-master');

        // What cannot be asked: a second question, a project that is running, the Master, a name that is nobody's, an opted-out project.
        const again = await masterWrites(a.routeId, 'ask-launch', { expectedVersion: version(a.routeId), project: a.project.id });
        assert.deepEqual([again.status, again.body.code], [409, 'QUESTION_OPEN']);
        const other = (await operatorWrites(`m${++seq}`, '@nobody-at-all hello')).body.routeId;
        const live = liveProject(`Alpha${++seq}`);
        for (const [project, status, code] of [[live.project.id, 409, 'TARGET_LIVE'], ['master', 400, 'UNKNOWN_DESTINATION'], ['No Such Project', 400, 'UNKNOWN_DESTINATION'], [undefined, 400, 'UNKNOWN_DESTINATION']]) {
          const res = await masterWrites(other, 'ask-launch', { expectedVersion: version(other), project });
          assert.deepEqual([res.status, res.body.code], [status, code], String(project));
        }
        const out = stopped();
        db().prepare("INSERT INTO bridge_project_optouts (project_id, set_by, set_at) VALUES (?, 'operator', ?)").run(out.id, new Date().toISOString());
        const refused = await masterWrites(other, 'ask-launch', { expectedVersion: version(other), project: out.id });
        assert.deepEqual([refused.status, refused.body.code], [409, 'DESTINATION_OPTED_OUT']);
        assert.equal(db().prepare('SELECT COUNT(*) AS n FROM bridge_questions WHERE route_id = ?').get(other).n, 0);
      } finally { restore(); }
    });

    it('a yes, adopted: the server launches once with the saved settings, waits for READY, and sends the original on as written', async () => {
      try {
        const c = await consented();
        assert.equal(bridgeStore.routes.get(c.routeId).state, 'awaiting-master', 'recording consent sends nothing: the message is still held');
        assert.deepEqual([launchOf(c.routeId).state, launchOf(c.routeId).projectId], ['queued', c.project.id], 'and the launch it recorded is not undone by its own write');
        assert.deepEqual(launched, [], 'the Master\'s write launched nothing itself');
        const twice = await masterWrites(c.routeId, 'ask-launch', { expectedVersion: version(c.routeId), project: c.project.id });
        assert.deepEqual([twice.status, twice.body.code], [409, 'LAUNCH_IN_PROGRESS'], 'a message with a launch under way is not asked about launching again');
        assert.deepEqual([bridgeStore.routes.get(c.reply).state, questionOf(c.routeId).state, questionOf(c.routeId).adopted_for], ['closed', 'adopted', 'launch']);

        await gateway.tick();
        assert.equal(launched.length, 1);
        assert.deepEqual([launched[0].length, launched[0][0].id], [1, c.project.id], 'the project, and nothing else: no engine, mode, prompt or permission is passed');
        const flying = launchOf(c.routeId);
        assert.deepEqual([flying.state, flying.startedSession], ['waiting-ready', true]);
        const session = store.sessions.getActive(c.project.id);
        assert.deepEqual([flying.sessionId, flying.launchId], [session.id, store.launchSequences.getBySession(session.id).launchId]);
        const workspace = hub.workspaces.get(String(session.id));
        for (let i = 0; i < 3; i++) await gateway.tick();
        assert.deepEqual(sentTo(workspace), [], 'nothing is sent before the session says it is READY');
        assert.equal(launched.length, 1, 'and the launch is not repeated');

        becomesReady(session.id);
        await gateway.tick();
        const sent = sentTo(workspace);
        assert.equal(sent.length, 1);
        assert.ok(sent[0].message.includes(`@${c.project.name} please run the nightly`), 'the original message, as the operator wrote it');
        assert.ok(!sent[0].message.includes('yes'));
        assert.deepEqual([bridgeStore.routes.get(c.routeId).state, launchOf(c.routeId).state], ['routed', 'dispatched']);
        const route = bridgeStore.routes.get(c.routeId);
        assert.deepEqual([route.resolvedBy, route.destination.projectId], ['master', c.project.id], 'sent on the Master\'s decision, to the project consent was given for');
        for (let i = 0; i < 2; i++) await gateway.tick();
        assert.deepEqual([launched.length, sentTo(workspace).length], [1, 1], 'once');
        const trail = db().prepare("SELECT op, outcome FROM bridge_audit WHERE route_id = ? AND op IN ('ask-launch','launch','launch-dispatch') ORDER BY audit_seq").all(c.routeId).map((r) => `${r.op}:${r.outcome}`);
        assert.deepEqual(trail, ['ask-launch:applied', 'launch:applied', 'ask-launch:launch-in-progress', 'launch:waiting-ready', 'launch-dispatch:applied'], 'the question, the decision, the refused second question and the action are all on the record');
      } finally { restore(); }
    });

    it('no, or cancel: the message is closed with the reply, and nothing is launched or sent', async () => {
      try {
        const a = await asked();
        const reply = await operatorReplies(a.posted, 'no, leave it');
        const res = await masterWrites(a.routeId, 'decline', { expectedVersion: version(a.routeId), answeredBy: reply });
        assert.equal(res.status, 200, JSON.stringify(res.body));
        assert.deepEqual([bridgeStore.routes.get(a.routeId).state, bridgeStore.routes.get(reply).state], ['closed', 'closed']);
        assert.equal(bridgeStore.routes.body(a.routeId, 'inbound').text, null, 'its text is cleared');
        assert.deepEqual([questionOf(a.routeId).state, questionOf(a.routeId).adopted_for], ['declined', 'decline']);
        for (let i = 0; i < 3; i++) await gateway.tick();
        assert.deepEqual([launched.length, launchOf(a.routeId), store.sessions.getActive(a.project.id)], [0, null, null]);
        // A clarifying question can be declined the same way: the operator says to drop it.
        const plain = (await operatorWrites(`m${++seq}`, '@nobody-known do the thing')).body.routeId;
        assert.equal((await masterWrites(plain, 'ask', { expectedVersion: version(plain), text: 'Which project?' })).status, 200);
        const item = about(await claimAll(), plain).find((i) => i.kind === 'question');
        assert.equal((await ackItem(item, `dl${++seq}`)).status, 200);
        const never = await operatorReplies(`dl${seq}`, 'never mind, cancel');
        const dropped = await masterWrites(plain, 'decline', { expectedVersion: version(plain), answeredBy: never });
        assert.deepEqual([dropped.status, bridgeStore.routes.get(plain).state, bridgeStore.routes.get(never).state], [200, 'closed', 'closed']);
        // A decline needs the reply it rests on, like a launch.
        const b = await asked();
        for (const answeredBy of [undefined, '', 'not a route']) {
          const bad = await masterWrites(b.routeId, 'decline', { expectedVersion: version(b.routeId), answeredBy });
          assert.deepEqual([bad.status, bad.body.code], [400, 'BAD_ANSWERED_BY']);
        }
        const unrelated = (await operatorWrites(`m${++seq}`, 'no')).body.routeId;
        const wrong = await masterWrites(b.routeId, 'decline', { expectedVersion: version(b.routeId), answeredBy: unrelated });
        assert.deepEqual([wrong.status, wrong.body.code, bridgeStore.routes.get(b.routeId).state], [409, 'NOT_AN_ANSWER', 'awaiting-master']);
      } finally { restore(); }
    });

    it('no answer in an hour launches nothing: the message stays held and the operator is told so', async () => {
      try {
        const a = await asked();
        const late = await operatorReplies(a.posted, 'yes');
        await later(60 * MIN + 1000, async () => {
          const res = await masterWrites(a.routeId, 'launch', { expectedVersion: version(a.routeId), answeredBy: late });
          assert.deepEqual([res.status, res.body.code], [409, 'QUESTION_EXPIRED'], 'a yes adopted after the hour is consent to nothing');
          await gateway.tick();
          assert.equal(questionOf(a.routeId).state, 'expired');
          assert.deepEqual([launched.length, launchOf(a.routeId)], [0, null]);
          assert.equal(bridgeStore.routes.get(a.routeId).state, 'awaiting-master');
          assert.equal(bridgeStore.routes.body(a.routeId, 'inbound').text, `@${a.project.name} please run the nightly`);
          assert.deepEqual(about(await claimAll(), a.routeId).filter((i) => i.kind === 'failure').map((i) => i.text), [bridgeStore.QUESTION_EXPIRED_TEXT.launch]);
          const settled = await masterWrites(a.routeId, 'launch', { expectedVersion: version(a.routeId), answeredBy: late });
          assert.deepEqual([settled.status, settled.body.code], [409, 'QUESTION_SETTLED']);
          for (let i = 0; i < 2; i++) await gateway.tick();
          assert.equal(launched.length, 0);
        });
      } finally { restore(); }
    });

    it('only the reply to that launch question is consent: not a second yes, an unrelated yes, or an answer to another kind of question', async () => {
      try {
        const c = await consented();
        const second = await operatorReplies(c.posted, 'yes yes');
        const dup = await masterWrites(c.routeId, 'launch', { expectedVersion: version(c.routeId), answeredBy: second });
        assert.deepEqual([dup.status, dup.body.code], [409, 'QUESTION_SETTLED'], 'a duplicate yes finds the question already answered');
        assert.equal(db().prepare('SELECT COUNT(*) AS n FROM bridge_launches WHERE route_id = ?').get(c.routeId).n, 1);

        const a = await asked();
        const unrelated = (await operatorWrites(`m${++seq}`, 'yes')).body.routeId;
        const other = await asked();
        const crossed = await operatorReplies(other.posted, 'yes');
        for (const [answeredBy, why] of [[unrelated, 'a yes that replies to nothing'], [crossed, 'a yes to a question about another message'], [a.routeId, 'the message itself']]) {
          const res = await masterWrites(a.routeId, 'launch', { expectedVersion: version(a.routeId), answeredBy });
          assert.deepEqual([res.status, res.body.code], [409, 'NOT_AN_ANSWER'], why);
        }
        // A yes to a launch question is not an answer for an ordinary route write, and a clarifying answer is not consent to launch.
        const yes = await operatorReplies(a.posted, 'yes');
        const asRoute = await masterWrites(a.routeId, 'route', { expectedVersion: version(a.routeId), to: 'master', answeredBy: yes });
        assert.deepEqual([asRoute.status, asRoute.body.code], [409, 'QUESTION_PURPOSE']);
        const plain = (await operatorWrites(`m${++seq}`, '@nobody-known which?')).body.routeId;
        assert.equal((await masterWrites(plain, 'ask', { expectedVersion: version(plain), text: 'Which project?' })).status, 200);
        const item = about(await claimAll(), plain).find((i) => i.kind === 'question');
        assert.equal((await ackItem(item, `dl${++seq}`)).status, 200);
        const clarified = await operatorReplies(db().prepare('SELECT part_external_id AS id FROM bridge_outbound_parts WHERE outbound_id = ?').get(item.outboundId).id, 'yes, launch it');
        const asLaunch = await masterWrites(plain, 'launch', { expectedVersion: version(plain), answeredBy: clarified });
        assert.deepEqual([asLaunch.status, asLaunch.body.code], [409, 'QUESTION_PURPOSE']);
        for (let i = 0; i < 2; i++) await gateway.tick();
        assert.equal(launched.length, 1, 'only the one consented launch ever ran');
        assert.equal(launchOf(a.routeId), null);
      } finally { restore(); }
    });

    it('a session started by hand in the meantime is waited on, and nothing is launched', async () => {
      try {
        const c = await consented();
        const manual = hub.anotherSession(c.project);
        db().prepare("UPDATE launch_sequences SET applicability = 'applicable' WHERE session_id = ?").run(manual.sessionId);
        await gateway.tick();
        assert.deepEqual(launched, [], 'asked immediately before launching: one is already live');
        assert.deepEqual([launchOf(c.routeId).state, launchOf(c.routeId).sessionId, launchOf(c.routeId).startedSession], ['waiting-ready', manual.sessionId, false]);
        becomesReady(manual.sessionId);
        await gateway.tick();
        assert.equal(sentTo(manual.workspaceId).length, 1);
        assert.equal(launchOf(c.routeId).state, 'dispatched');
      } finally { restore(); }
    });

    it('a launch that is refused, fails, or throws is not retried and tries no other target; the operator and the Master are told the code', async () => {
      try {
        const CASES = [
          [() => ({ session: null, error: 'stranded', code: 'STRANDED_WRAPS' }), 'launch-refused:STRANDED_WRAPS'],
          [() => ({ session: null, error: 'Engine "x" not available (binary not found)' }), 'launch-refused:REFUSED'],
          [() => ({ session: null, error: null, webui: true }), 'launch-refused:WEBUI_ENGINE'],
          [() => ({ session: null, error: null }), 'launch-refused:REFUSED'],
          [() => { throw new Error('tmux went away'); }, 'launch-error']
        ];
        for (const [behaviour, code] of CASES) {
          launched = [];
          launchBehaviour = behaviour;
          const c = await consented();
          const heldVersion = version(c.routeId);
          await gateway.tick();
          const launch = launchOf(c.routeId);
          assert.deepEqual([launch.state, launch.failureCode], ['failed', code]);
          const route = bridgeStore.routes.get(c.routeId);
          assert.deepEqual([route.state, route.failureCode, route.destination], ['awaiting-master', code.slice(0, 40), null], `${code}: the message goes back to waiting, saying why`);
          assert.ok(route.version > heldVersion, 'its version moves, so the Master is told');
          assert.equal(bridgeStore.routes.body(c.routeId, 'inbound').text, `@${c.project.name} please run the nightly`);
          const notices = about(await claimAll(), c.routeId).filter((i) => i.kind === 'failure').map((i) => i.text);
          assert.deepEqual(notices, [`I could not get a session ready for your message (${code}). Your message is still held, and nothing was sent on.`]);
          for (let i = 0; i < 3; i++) await gateway.tick();
          assert.equal(launched.length, 1, `${code}: launched once, and never again without a new consent`);
          assert.equal(hub.fromGateway().filter((m) => m.message.includes(c.project.name)).length, 0, 'and sent to nobody');
        }
      } finally { restore(); }
    });

    describe('a failed launch is ended, marked on its message and reported in one write (#2112)', () => {
      const failureRows = (routeId) => db().prepare("SELECT outbound_id, idem_key, text, digest FROM bridge_outbound WHERE route_id = ? AND kind = 'failure' ORDER BY outbound_id").all(routeId);
      const applied = (routeId, op) => bridgeStore.audit.forRoute(routeId).filter((a) => a.op === op && (op === 'launch' ? a.outcome === 'failed' : a.outcome === 'applied'));
      /** Everything the failure writes, as it stands. */
      const standing = (c) => JSON.stringify({
        route: db().prepare('SELECT state, version, failure_code FROM bridge_routes WHERE route_id = ?').get(c.routeId),
        launch: db().prepare('SELECT state, failure_code, settled_at FROM bridge_launches WHERE route_id = ? ORDER BY launch_seq DESC LIMIT 1').get(c.routeId),
        notices: failureRows(c.routeId).length,
        ended: applied(c.routeId, 'launch').length,
        marked: applied(c.routeId, 'launch-failed').length
      });
      /** A consented launch whose session started and is waited for. */
      const waitedFor = async () => {
        const c = await consented();
        await gateway.tick();
        assert.equal(launchOf(c.routeId).state, 'waiting-ready');
        return c;
      };
      const NOTICE = 'I could not get a session ready for your message (ready-timeout). Your message is still held, and nothing was sent on.';
      /**
       * Each place the three old writes used to part: the store is made to fail there, once the write has got that
       * far, and only the first time, as a passing fault would. A second try in the same pass would succeed.
       */
      const once = (fn) => { let spent = false; return (...args) => { if (!spent && fn(...args)) { spent = true; return true; } return false; }; };
      const BOUNDARIES = {
        'as the launch is ended': (real) => {
          const here = once((row) => row.op === 'launch' && row.outcome === 'failed');
          bridgeStore.audit.append = (row) => { if (here(row)) throw new Error('injected: at the launch\'s end'); return real.append.call(bridgeStore.audit, row); };
        },
        'as the notice is queued': (real) => {
          const here = once((item) => item.kind === 'failure');
          bridgeStore.outbound.enqueue = (item) => { if (here(item)) throw new Error('injected: at the notice'); return real.enqueue.call(bridgeStore.outbound, item); };
        },
        'as the message is marked': (real) => {
          const here = once((row) => row.op === 'launch-failed');
          bridgeStore.audit.append = (row) => { if (here(row)) throw new Error('injected: at the route\'s record'); return real.append.call(bridgeStore.audit, row); };
        }
      };

      it('all three land together: the launch ended, the message marked, and one fixed notice in reply to the operator\'s message', async () => {
        try {
          const c = await waitedFor();
          const before = bridgeStore.routes.get(c.routeId);
          await later(gateway.READY_WAIT_MS + 5000, () => gateway.tick());
          const launch = launchOf(c.routeId);
          const route = bridgeStore.routes.get(c.routeId);
          assert.deepEqual([launch.state, launch.failureCode], ['failed', 'ready-timeout']);
          assert.deepEqual([route.state, route.failureCode, route.version], ['awaiting-master', 'ready-timeout', before.version + 1], 'still held, and carrying the code');
          const rows = failureRows(c.routeId);
          assert.deepEqual(rows.map((r) => [r.idem_key, r.text]), [[`route:${c.routeId}:launch-failed:${launch.launchSeq}`, NOTICE]]);
          const posted = about(await claimAll(), c.routeId).filter((i) => i.kind === 'failure');
          assert.deepEqual(posted.map((i) => [i.outboundId, i.sourceLabel, i.text, i.inReplyTo.externalId]),
            [[rows[0].outbound_id, 'TangleClaw', NOTICE, bridgeStore.routes.get(c.routeId).externalId]]);
          // One instant and one record of each: the launch's end, and the write that marked the message and names the notice it queued.
          const [ended] = applied(c.routeId, 'launch');
          const [marked] = applied(c.routeId, 'launch-failed');
          assert.deepEqual([applied(c.routeId, 'launch').length, applied(c.routeId, 'launch-failed').length], [1, 1]);
          assert.deepEqual(marked.detail, { launchSeq: launch.launchSeq, code: 'ready-timeout', outboundId: rows[0].outbound_id });
          assert.deepEqual([ended.detail.launchSeq, ended.detail.code, ended.actor, marked.actor], [launch.launchSeq, 'ready-timeout', 'gateway', 'gateway']);
          assert.equal(ended.at, marked.at, 'written together');
          assert.equal(launch.settledAt, marked.at);
        } finally { restore(); }
      });

      for (const [where, inject] of Object.entries(BOUNDARIES)) {
        it(`a stop ${where} leaves none of it, and the next pass does all of it, once`, async () => {
          const real = { append: bridgeStore.audit.append, enqueue: bridgeStore.outbound.enqueue };
          try {
            const c = await waitedFor();
            const before = standing(c);
            let hit = 0;
            inject(real);
            for (const [object, name] of [[bridgeStore.audit, 'append'], [bridgeStore.outbound, 'enqueue']]) {
              const injected = object[name];
              object[name] = (...args) => { try { return injected(...args); } catch (err) { if (/^injected/.test(err.message)) hit += 1; throw err; } };
            }
            try {
              await later(gateway.READY_WAIT_MS + 5000, () => gateway.tick().catch(() => {}));
            } finally { bridgeStore.audit.append = real.append; bridgeStore.outbound.enqueue = real.enqueue; }
            assert.equal(hit, 1, 'the write got as far as the injected failure, once');
            assert.equal(standing(c), before, 'none of the three landed, and the same pass did not end it as something else');
            assert.equal(launchOf(c.routeId).state, 'waiting-ready', 'so the launch is still one a pass comes back to');
            // As after a restart: nothing remembered. The next pass finds the launch and finishes the job.
            gateway._reset();
            await later(gateway.READY_WAIT_MS + 10000, () => gateway.tick());
            assert.deepEqual(JSON.parse(standing(c)).notices, 1);
            assert.deepEqual([launchOf(c.routeId).state, launchOf(c.routeId).failureCode, bridgeStore.routes.get(c.routeId).failureCode], ['failed', 'ready-timeout', 'ready-timeout']);
            assert.deepEqual([applied(c.routeId, 'launch').length, applied(c.routeId, 'launch-failed').length], [1, 1]);
            // And nothing after that makes a second notice, before or after the helper has posted the first.
            const after = standing(c);
            for (let i = 0; i < 3; i++) { gateway._reset(); await later(gateway.READY_WAIT_MS + 20000 + i, () => gateway.tick()); }
            assert.equal(standing(c), after);
            const item = about(await claimAll(), c.routeId).find((i) => i.kind === 'failure');
            assert.equal((await ackItem(item, `dn-launch-${++seq}`)).status, 200);
            for (let i = 0; i < 2; i++) { gateway._reset(); await later(gateway.READY_WAIT_MS + 30000 + i, () => gateway.tick()); }
            assert.equal(failureRows(c.routeId).length, 1);
            assert.deepEqual(about(await claimAll(), c.routeId).filter((i) => i.kind === 'failure'), [], 'nothing waits to be posted twice');
          } finally { bridgeStore.audit.append = real.append; bridgeStore.outbound.enqueue = real.enqueue; restore(); }
        });
      }

      it('a launch refused before it begins, whose failure could not be written, is refused again for that reason and not ended as an error', async () => {
        const real = { append: bridgeStore.audit.append };
        try {
          const c = await consented();
          const behind = await consented();
          assert.deepEqual([launchOf(c.routeId).state, launchOf(behind.routeId).state], ['queued', 'queued']);
          assert.equal((await asOperator('POST', '/api/bridge/operator/optouts', { body: { project: c.project.id } })).status, 200);
          const before = standing(c);
          BOUNDARIES['as the message is marked'](real);
          try { await gateway.tick().catch(() => {}); } finally { bridgeStore.audit.append = real.append; }
          assert.equal(standing(c), before, 'nothing landed, under any code');
          assert.equal(launchOf(c.routeId).state, 'queued');
          // The pass stopped there. The one behind did not take its turn ahead of a launch that is still unsettled.
          assert.deepEqual([launchOf(behind.routeId).state, launched.filter((args) => args[0].id === behind.project.id).length], ['queued', 0]);
          gateway._reset();
          await gateway.tick();
          assert.deepEqual([launchOf(c.routeId).state, launchOf(c.routeId).failureCode, bridgeStore.routes.get(c.routeId).failureCode], ['failed', 'project-opted-out', 'project-opted-out']);
          assert.deepEqual(failureRows(c.routeId).map((r) => r.text), ['I could not get a session ready for your message (project-opted-out). Your message is still held, and nothing was sent on.']);
          assert.equal(launched.filter((args) => args[0].id === c.project.id).length, 0, 'and nothing was ever launched for it');
          assert.equal(launchOf(behind.routeId).state, 'waiting-ready', 'with that one settled, the one behind takes its turn');
          bridgeStore.optouts.remove(c.project.id);
        } finally { bridgeStore.audit.append = real.append; restore(); }
      });

      it('a launch that is already ended is not reported again by a write that names it, and one that is another message\'s is not touched', async () => {
        try {
          const c = await waitedFor();
          await later(gateway.READY_WAIT_MS + 5000, () => gateway.tick());
          const launch = launchOf(c.routeId);
          const after = standing(c);
          const again = (routeId, requestId) => bridgeStore.applyRouteWrite({
            op: 'launch-failed', requestId, routeId, expectedVersion: bridgeStore.routes.get(routeId).version, actor: 'gateway', proof: 'gateway',
            change: () => ({
              set: { failure_code: 'launch-error' }, detail: { launchSeq: launch.launchSeq, code: 'launch-error' },
              failLaunch: { launchSeq: launch.launchSeq, code: 'launch-error' },
              outbound: { idemKey: `route:${routeId}:launch-failed:${launch.launchSeq}:again`, kind: 'failure', sourceLabel: 'TangleClaw', text: 'x', digest: bridgeStore.digest('x') }
            })
          });
          assert.equal(again(c.routeId, `gw:test-again:${++seq}`).outcome, 'launch-settled');
          assert.equal(standing(c), after, 'nothing marked, nothing queued');
          // A write on one message cannot end the launch of another.
          const other = await waitedFor();
          const otherBefore = standing(other);
          const mine = standing(c);
          const crossed = bridgeStore.applyRouteWrite({
            op: 'launch-failed', requestId: `gw:test-cross:${++seq}`, routeId: c.routeId, expectedVersion: bridgeStore.routes.get(c.routeId).version, actor: 'gateway', proof: 'gateway',
            change: () => ({ set: { failure_code: 'launch-error' }, detail: {}, failLaunch: { launchSeq: launchOf(other.routeId).launchSeq, code: 'launch-error' } })
          });
          assert.equal(crossed.outcome, 'launch-settled');
          assert.deepEqual([standing(other), standing(c)], [otherBefore, mine]);
        } finally { restore(); }
      });

      it('a message that is no longer held has nothing to mark and nobody to tell: its launch is still ended', async () => {
        try {
          const c = await waitedFor();
          // Not a state the bridge leaves a waited-for launch in, since leaving the held state ends it; forced, to hold the branch to its word.
          db().prepare("UPDATE bridge_routes SET state = 'routed', destination_kind = 'master', resolved_by = 'master', resolved_generation = 1 WHERE route_id = ?").run(c.routeId);
          const version = bridgeStore.routes.get(c.routeId).version;
          await later(gateway.READY_WAIT_MS + 5000, () => gateway.tick());
          assert.deepEqual([launchOf(c.routeId).state, launchOf(c.routeId).failureCode], ['failed', 'ready-timeout']);
          assert.deepEqual([bridgeStore.routes.get(c.routeId).version, bridgeStore.routes.get(c.routeId).failureCode, failureRows(c.routeId).length], [version, null, 0]);
          assert.equal(applied(c.routeId, 'launch').length, 1);
          db().prepare("UPDATE bridge_routes SET state = 'closed', closed_at = ? WHERE route_id = ?").run(new Date().toISOString(), c.routeId);
        } finally { restore(); }
      });

      it('the notice and its record carry a closed code and nothing of the message, the session or any credential', async () => {
        try {
          const SECRET = 'heron-basalt-4419';
          const project = stopped();
          const accepted = await operatorWrites(`m${++seq}`, `@${project.name} run it with ${SECRET}`);
          const routeId = accepted.body.routeId;
          assert.equal((await masterWrites(routeId, 'ask-launch', { expectedVersion: version(routeId), project: project.id })).status, 200);
          const question = about(await claimAll(), routeId).find((i) => i.kind === 'question');
          assert.equal((await ackItem(question, `dl${++seq}`)).status, 200);
          const reply = await operatorReplies(`dl${seq}`, `yes, ${SECRET}`);
          assert.equal((await masterWrites(routeId, 'launch', { expectedVersion: version(routeId), answeredBy: reply })).status, 200);
          await gateway.tick();
          const waited = launchOf(routeId);
          const session = store.sessions.getActive(project.id);
          await later(gateway.READY_WAIT_MS + 5000, () => gateway.tick());
          const claimed = about(await claimAll(), routeId).filter((i) => i.kind === 'failure');
          assert.equal(claimed.length, 1);
          const everything = JSON.stringify([
            claimed, failureRows(routeId),
            bridgeStore.audit.forRoute(routeId).filter((a) => a.op === 'launch' || a.op === 'launch-failed')
          ]);
          const helperToken = bridgeStore.helperTokens.active();
          for (const [what, value] of [['the message', SECRET], ['the project\'s name', project.name], ['the session\'s launch id', waited.launchId],
            ['the session\'s workspace', hub.workspaces.get(String(session.id))], ['the helper token', helperToken && helperToken.tokenId]]) {
            assert.ok(value && !everything.includes(String(value)), `${what} is not in the notice or its record`);
          }
          assert.equal(claimed[0].text, NOTICE);
          assert.equal(failureRows(routeId)[0].digest, bridgeStore.digest(NOTICE));
          assert.match(NOTICE, /\(ready-timeout\)/, 'what it says of the cause is one of a closed list');
        } finally { restore(); }
      });
    });

    it('READY that never comes, or comes from another session, sends nothing: the launch ends after ten minutes and the session is left running', async () => {
      try {
        assert.equal(gateway.READY_WAIT_MS, 10 * MIN, 'ten minutes, as ruled');
        // Never READY.
        const slow = await consented();
        await gateway.tick();
        const session = store.sessions.getActive(slow.project.id);
        await later(gateway.READY_WAIT_MS - 1000, async () => {
          await gateway.tick();
          assert.equal(launchOf(slow.routeId).state, 'waiting-ready', 'inside the wait it is still waited for');
        });
        await later(gateway.READY_WAIT_MS + 5000, async () => {
          await gateway.tick();
          assert.deepEqual([launchOf(slow.routeId).state, launchOf(slow.routeId).failureCode], ['failed', 'ready-timeout']);
          assert.equal(store.sessions.getActive(slow.project.id).id, session.id, 'the session that did start is not ended');
          becomesReady(session.id);
          await gateway.tick();
          assert.deepEqual(sentTo(hub.workspaces.get(String(session.id))), [], 'a READY that arrives after the launch was given up sends nothing');
          assert.equal(bridgeStore.routes.get(slow.routeId).state, 'awaiting-master');
        });

        // The session is replaced before it is READY: the new one is not the one consent launched.
        const swapped = await consented();
        await gateway.tick();
        const first = store.sessions.getActive(swapped.project.id);
        store.sessions.kill(first.id, 'replaced');
        const usurper = hub.anotherSession(swapped.project);
        db().prepare("UPDATE launch_sequences SET applicability = 'applicable' WHERE session_id = ?").run(usurper.sessionId);
        becomesReady(usurper.sessionId);
        becomesReady(first.id);
        await gateway.tick();
        assert.deepEqual([launchOf(swapped.routeId).state, launchOf(swapped.routeId).failureCode], ['failed', 'identity-changed']);
        assert.deepEqual(sentTo(usurper.workspaceId), [], 'READY alone, from whichever session is newest, is not enough');

        // READY, but the server holds no listener for that session: not sent.
        const deaf = await consented();
        await gateway.tick();
        const quiet = store.sessions.getActive(deaf.project.id);
        const workspace = hub.workspaces.get(String(quiet.id));
        hub.workspaces.delete(String(quiet.id));
        becomesReady(quiet.id);
        await gateway.tick();
        assert.equal(launchOf(deaf.routeId).state, 'waiting-ready', 'READY with no listener is still waiting');
        assert.deepEqual(sentTo(workspace), []);
        hub.workspaces.set(String(quiet.id), workspace);
        await gateway.tick();
        assert.deepEqual([launchOf(deaf.routeId).state, sentTo(workspace).length], ['dispatched', 1]);

        // READY, but its recovery gate is withheld: not sent until the operator has cleared it.
        const gated = await consented();
        await gateway.tick();
        const guarded = store.sessions.getActive(gated.project.id);
        db().prepare("UPDATE launch_sequences SET recovery = 'required', recovery_mode = 'operator' WHERE session_id = ?").run(guarded.id);
        becomesReady(guarded.id);
        await gateway.tick();
        assert.equal(launchOf(gated.routeId).state, 'waiting-ready', 'a withheld recovery gate holds the message back');
        assert.deepEqual(sentTo(hub.workspaces.get(String(guarded.id))), []);
        db().prepare("UPDATE launch_sequences SET recovery = 'cleared' WHERE session_id = ?").run(guarded.id);
        await gateway.tick();
        assert.equal(launchOf(gated.routeId).state, 'dispatched');

        // The session is replaced in the instant between the decision to send and the send: it does not go to the newcomer.
        const raced = await consented();
        await gateway.tick();
        const original = store.sessions.getActive(raced.project.id);
        const launch = launchOf(raced.routeId);
        const sentOn = bridgeStore.applyRouteWrite({
          op: 'launch-dispatch', requestId: `req-race-${++seq}-0000`, routeId: raced.routeId, expectedVersion: version(raced.routeId), actor: 'gateway', proof: 'gateway',
          change: () => ({
            set: { state: 'accepted', resolved_by: 'master', destination_kind: 'project', destination_project_id: raced.project.id, resolved_generation: launch.masterGeneration, failure_code: null },
            settleLaunch: { launchSeq: launch.launchSeq }
          })
        });
        assert.equal(sentOn.outcome, 'applied');
        store.sessions.kill(original.id, 'replaced');
        const newcomer = hub.anotherSession(raced.project);
        await gateway.advance(raced.routeId);
        const bounced = bridgeStore.routes.get(raced.routeId);
        assert.deepEqual([bounced.state, bounced.failureCode], ['awaiting-master', 'identity-changed']);
        assert.deepEqual([sentTo(newcomer.workspaceId), sentTo(hub.workspaces.get(String(original.id)))], [[], []], 'sent to neither: the Master decides again');
        // And the Master's next decision is its own: the launch that is over does not stand in the way of the session that is live now.
        const rerouted = await masterWrites(raced.routeId, 'route', { expectedVersion: version(raced.routeId), to: raced.project.id });
        assert.deepEqual([rerouted.status, rerouted.body.route.state], [200, 'routed'], JSON.stringify(rerouted.body));
        assert.equal(sentTo(newcomer.workspaceId).length, 1, 'a settled launch governs the one send it made, and no later one');

        // A session whose launch can never attest is said to be that at once (its own test, below, holds the rest).
        launchBehaviour = (project) => { hub.anotherSession(project); return { session: store.sessions.getActive(project.id), error: null }; };
        const mute = await consented();
        await gateway.tick();
        await gateway.tick();
        assert.deepEqual([launchOf(mute.routeId).state, launchOf(mute.routeId).failureCode], ['failed', 'ready-not-applicable']);
      } finally { restore(); }
    });

    it('a session that can never attest READY: failed at once, nothing sent, the session left running, and a later route is a new decision', async () => {
      try {
        // The launch succeeds, and its launch sequence is one with nothing to attest.
        launchBehaviour = (project) => { hub.anotherSession(project); return { session: store.sessions.getActive(project.id), error: null }; };
        const c = await consented();
        const heldVersion = version(c.routeId);
        await gateway.tick();
        const session = store.sessions.getActive(c.project.id);
        const workspace = hub.workspaces.get(String(session.id));
        assert.equal(store.launchSequences.getBySession(session.id).applicability === 'applicable', false, 'precondition: this session can never say it is READY');
        await gateway.tick();

        // Settled as failed, with the closed code, on the audit.
        const launch = launchOf(c.routeId);
        assert.deepEqual([launch.state, launch.failureCode, launch.sessionId], ['failed', 'ready-not-applicable', session.id]);
        assert.ok(Date.parse(launch.settledAt) - Date.parse(launch.startedAt) < gateway.READY_WAIT_MS, 'at once, not after the ten-minute wait');
        const audit = db().prepare("SELECT outcome, detail_json FROM bridge_audit WHERE op = 'launch' AND route_id = ? ORDER BY audit_seq").all(c.routeId);
        assert.deepEqual(audit.map((r) => r.outcome), ['applied', 'waiting-ready', 'failed']);
        assert.deepEqual([JSON.parse(audit[2].detail_json).code, JSON.parse(audit[2].detail_json).sessionId], ['ready-not-applicable', session.id]);
        // The held original is never sent on by the launch.
        assert.deepEqual(sentTo(workspace), [], 'the original was not dispatched');
        // It is back with the Master, still held, with the code on it and its text intact.
        const route = bridgeStore.routes.get(c.routeId);
        assert.deepEqual([route.state, route.failureCode, route.destination], ['awaiting-master', 'ready-not-applicable', null]);
        assert.ok(route.version > heldVersion, 'its version moved, so the Master is told');
        assert.equal(bridgeStore.routes.body(c.routeId, 'inbound').text, `@${c.project.name} please run the nightly`);
        // The operator gets the fixed sentence, once.
        const notices = about(await claimAll(), c.routeId).filter((i) => i.kind === 'failure').map((i) => i.text);
        assert.deepEqual(notices, ['I could not get a session ready for your message (ready-not-applicable). Your message is still held, and nothing was sent on.']);
        // The session that did start is left running, and nothing else is launched or retried.
        for (let i = 0; i < 4; i++) await gateway.tick();
        assert.equal(store.sessions.getActive(c.project.id).id, session.id, 'the started session is still the active one');
        assert.equal(launched.length, 1, 'no retry and no second session');
        assert.deepEqual(sentTo(workspace), [], 'and still nothing sent: no pass picks the failed launch up again');
        assert.equal(db().prepare('SELECT COUNT(*) AS n FROM bridge_launches WHERE route_id = ?').get(c.routeId).n, 1);
        assert.equal(db().prepare("SELECT COUNT(*) AS n FROM bridge_outbound WHERE route_id = ? AND kind = 'failure' AND idem_key LIKE '%launch-failed%'").get(c.routeId).n, 1, 'told once');

        // Sending it there now is the Master's own, new decision, under the ordinary rules for a live session.
        const again = await masterWrites(c.routeId, 'ask-launch', { expectedVersion: version(c.routeId), project: c.project.id });
        assert.deepEqual([again.status, again.body.code], [409, 'TARGET_LIVE'], 'there is nothing to launch: the project is running');
        const routed = await masterWrites(c.routeId, 'route', { expectedVersion: version(c.routeId), to: c.project.id });
        assert.deepEqual([routed.status, routed.body.route.state], [200, 'routed'], JSON.stringify(routed.body));
        assert.equal(sentTo(workspace).length, 1);
        const decision = db().prepare("SELECT actor, detail_json FROM bridge_audit WHERE op = 'route' AND route_id = ? AND outcome = 'applied' ORDER BY audit_seq DESC LIMIT 1").get(c.routeId);
        assert.equal(decision.actor, 'master', 'on the Master\'s route write, not the gateway\'s launch-dispatch');
        assert.equal(db().prepare("SELECT COUNT(*) AS n FROM bridge_audit WHERE op = 'launch-dispatch' AND route_id = ?").get(c.routeId).n, 0, 'the failed launch dispatched nothing, then or later');
        assert.equal(launchOf(c.routeId).state, 'failed', 'and it is still a failed launch: the route did not continue it');
      } finally { restore(); }
    });

    it('a launched session with Medusa switched off: READY is not enough, and after ten minutes the launch ends with nothing sent or retried', async () => {
      // Whether a project's session will have a listener cannot be known before it runs, so this launch is made.
      // It may hold the one launch slot for the ten minutes of the wait, and no longer (Architect ruling, 2026-10-05).
      try {
        const c = await consented();
        const behind = await consented();
        const heldVersion = version(c.routeId);
        await gateway.tick();
        const session = store.sessions.getActive(c.project.id);
        const workspace = hub.workspaces.get(String(session.id));
        hub.workspaces.delete(String(session.id));
        becomesReady(session.id);
        const realNow = gateway._deps.now;
        const started = Date.parse(launchOf(c.routeId).startedAt);
        const at = (ms) => { const iso = new Date(started + ms).toISOString(); gateway._deps.now = () => iso; };
        try {
          at(gateway.READY_WAIT_MS);
          await gateway.tick();
          assert.deepEqual([launchOf(c.routeId).state, launchOf(behind.routeId).state], ['waiting-ready', 'queued'], 'at exactly ten minutes it is still waited for, and holds the slot');
          assert.equal(launched.length, 1);
          at(gateway.READY_WAIT_MS + 1);
          await gateway.tick();
          assert.deepEqual([launchOf(c.routeId).state, launchOf(c.routeId).failureCode], ['failed', 'ready-timeout'], 'one millisecond later it is given up');
          // The original is still held, with the code on it, its text intact, and was sent to nobody.
          const route = bridgeStore.routes.get(c.routeId);
          assert.deepEqual([route.state, route.failureCode, route.destination], ['awaiting-master', 'ready-timeout', null]);
          assert.ok(route.version > heldVersion, 'its version moved, so the Master is told');
          assert.equal(bridgeStore.routes.body(c.routeId, 'inbound').text, `@${c.project.name} please run the nightly`);
          assert.equal(hub.fromGateway().filter((m) => m.message.includes(c.project.name)).length, 0, 'nothing was dispatched');
          // The operator is told once, in the fixed words.
          assert.deepEqual(about(await claimAll(), c.routeId).filter((i) => i.kind === 'failure').map((i) => i.text),
            ['I could not get a session ready for your message (ready-timeout). Your message is still held, and nothing was sent on.']);
          // The session is left running; the slot is free for the next in line; nothing is retried.
          assert.equal(store.sessions.getActive(c.project.id).id, session.id);
          assert.equal(launchOf(behind.routeId).state, 'waiting-ready', 'the next consented launch takes its turn in the same pass');
          assert.deepEqual(launched.map((args) => args[0].id), [c.project.id, behind.project.id]);
          // The listener comes on afterwards: the launch that was given up sends nothing, then or later.
          hub.workspaces.set(String(session.id), workspace);
          for (let i = 0; i < 3; i++) await gateway.tick();
          assert.deepEqual(sentTo(workspace), [], 'no automatic dispatch once the session can be reached');
          assert.equal(launched.filter((args) => args[0].id === c.project.id).length, 1, 'and no second launch');
          assert.equal(db().prepare("SELECT COUNT(*) AS n FROM bridge_audit WHERE op = 'launch-dispatch' AND route_id = ?").get(c.routeId).n, 0);
          assert.equal(launchOf(c.routeId).state, 'failed');
        } finally { gateway._deps.now = realNow; }
      } finally { restore(); }
    });

    it('every condition is asked again immediately before launching, and while waiting', async () => {
      try {
        const lane = (blocked, stopped) => () => ({ ...realControl(), blockingOf: () => ({ blocked, stopped, code: stopped ? 'CONTROL_STOPPED' : 'CONTROL_HELD' }) });
        const realScope = bridgeReach._deps.masterScope;
        const BEFORE = [
          ['project-archived', (c) => store.projects.archive(c.project.id), () => {}],
          ['scope-unresolved', () => { bridgeReach._deps.masterScope = () => ({ type: 'group', groupId: 'no-such-group' }); }, () => { bridgeReach._deps.masterScope = realScope; }],
          ['project-out-of-scope', () => { const g = store.projectGroups.create({ name: `Elsewhere${++seq}` }); bridgeReach._deps.masterScope = () => ({ type: 'group', groupId: g.id }); }, () => { bridgeReach._deps.masterScope = realScope; }],
          ['project-opted-out', (c) => db().prepare("INSERT INTO bridge_project_optouts (project_id, set_by, set_at) VALUES (?, 'operator', ?)").run(c.project.id, new Date().toISOString()), () => {}],
          ['held', () => { gateway._deps.controlState = lane(true, false); }, () => { gateway._deps.controlState = realControl; }],
          ['stopped', () => { gateway._deps.controlState = lane(true, true); }, () => { gateway._deps.controlState = realControl; }],
          ['control-unavailable', () => { gateway._deps.controlState = () => ({ blockingOf: () => { throw new Error('locked'); } }); }, () => { gateway._deps.controlState = realControl; }],
          ['wrap-running', () => { gateway._deps.sessions = () => ({ ...realSessions(), getWrapRunStatus: () => ({ running: true }) }); }, () => { gateway._deps.sessions = realSessions; }]
        ];
        for (const [code, arrange, undo] of BEFORE) {
          launched = [];
          const c = await consented();
          arrange(c);
          try {
            await gateway.tick();
            assert.deepEqual([launchOf(c.routeId).state, launchOf(c.routeId).failureCode, launched.length], ['failed', code, 0], `${code}: refused before anything is launched`);
            assert.equal(store.sessions.getActive(c.project.id), null);
          } finally { undo(); }
        }
        // While waiting: a lane held after the launch stops the message being sent, READY or not.
        launched = [];
        const c = await consented();
        await gateway.tick();
        const session = store.sessions.getActive(c.project.id);
        becomesReady(session.id);
        gateway._deps.controlState = lane(true, false);
        await gateway.tick();
        gateway._deps.controlState = realControl;
        assert.deepEqual([launchOf(c.routeId).state, launchOf(c.routeId).failureCode], ['failed', 'held']);
        assert.deepEqual(sentTo(hub.workspaces.get(String(session.id))), []);
      } finally { restore(); }
    });

    it('one launch is in flight on the install: the rest wait in the order consent was adopted, and each is judged when its turn comes', async () => {
      try {
        const first = await consented();
        const second = await consented();
        const third = await consented();
        await gateway.tick();
        assert.deepEqual([first, second, third].map((c) => launchOf(c.routeId).state), ['waiting-ready', 'queued', 'queued']);
        assert.equal(launched.length, 1);
        const read = await tc(['bridge', 'read', second.routeId]);
        assert.match(read.stdout, new RegExp(`launch of project #${second.project.id}: consented, waiting its turn`), 'a waiting launch is shown as that');
        for (let i = 0; i < 3; i++) await gateway.tick();
        assert.equal(launched.length, 1, 'nothing overtakes the one in flight');
        // The third's project is archived while it waits: judged when its turn comes, not before.
        store.projects.archive(third.project.id);
        becomesReady(store.sessions.getActive(first.project.id).id);
        await gateway.tick();
        assert.deepEqual([first, second, third].map((c) => launchOf(c.routeId).state), ['dispatched', 'waiting-ready', 'queued']);
        assert.deepEqual(launched.map((args) => args[0].id), [first.project.id, second.project.id], 'in the order consent was adopted');
        becomesReady(store.sessions.getActive(second.project.id).id);
        await gateway.tick();
        assert.deepEqual([first, second, third].map((c) => [launchOf(c.routeId).state, launchOf(c.routeId).failureCode]), [['dispatched', null], ['dispatched', null], ['failed', 'project-archived']]);
        assert.equal(launched.length, 2);
      } finally { restore(); }
    });

    it('closing the message, a restart, or the bridge being switched off never leaves a launch that runs later', async () => {
      try {
        // Closed while queued behind another: abandoned, never launched.
        const ahead = await consented();
        const closed = await consented();
        await gateway.tick();
        const res = await masterWrites(closed.routeId, 'close', { expectedVersion: version(closed.routeId) });
        assert.equal(res.body.route.state, 'closed');
        assert.equal(launchOf(closed.routeId).state, 'abandoned');
        // A restart in the middle: nothing the gateway remembered matters, and nothing is launched twice.
        gateway._reset();
        await gateway.tick();
        assert.equal(launched.length, 1);
        assert.equal(launchOf(ahead.routeId).state, 'waiting-ready');
        // The bridge is switched off with a launch in flight and another consented.
        const waiting = await consented();
        assert.equal((await asOperator('POST', '/api/bridge/operator/disable')).status, 200);
        await gateway.tick();
        assert.deepEqual([launchOf(ahead.routeId).state, launchOf(waiting.routeId).state], ['abandoned', 'abandoned']);
        const session = store.sessions.getActive(ahead.project.id);
        assert.ok(session, 'the session already started is left as it is');
        assert.equal((await asOperator('POST', '/api/bridge/operator/enable')).status, 200);
        becomesReady(session.id);
        for (let i = 0; i < 2; i++) await gateway.tick();
        assert.deepEqual(sentTo(hub.workspaces.get(String(session.id))), [], 'switching it back on revives nothing');
        assert.equal(launched.length, 1);
        assert.equal(store.sessions.getActive(waiting.project.id), null);
      } finally { restore(); }
    });

    it('reads what the real launch function answers: a session under `session`, or an `error`', () => {
      // The stand-in above is only as good as this: what `sessions.launchSession` really returns, here for a refusal.
      const refused = require('../lib/sessions').launchSession(`No Such Project ${++seq}`, { primePrompt: true, owner: null });
      assert.deepEqual([refused.session, typeof refused.error], [null, 'string']);
      assert.ok(!('sessionId' in refused), 'there is no sessionId at the top of its answer');
      assert.match(read('lib/bridge-gateway.js'), /const sessionId = result && result\.session \? result\.session\.id : null;/);
      assert.match(read('server.js'), /sessionId: result\.session\.id,/, 'which is how the launch route reads it too');
      // And both launch a session after the same warm-up, by the same function.
      assert.match(read('server.js'), /await launchWarmup\.warmForLaunch\(project\);/);
      assert.match(read('lib/bridge-gateway.js'), /warmForLaunch: \(project\) => require\('\.\/launch-warmup'\)\.warmForLaunch\(project\),/);
      assert.match(read('lib/bridge-gateway.js'), /launchSession: \(project\) => require\('\.\/sessions'\)\.launchSession\(project\.name, \{ primePrompt: true, owner: null \}\),/);
      // Nothing is awaited between the checks and the launch: the warm-up is the last await before it.
      const begin = /async function _beginLaunch\(launch\) \{[\s\S]*?\n\}\n/.exec(read('lib/bridge-gateway.js'))[0];
      assert.equal(begin.split('await ').length - 1, 1, 'one await in the whole of it');
      assert.ok(begin.indexOf('await _deps.warmForLaunch') < begin.indexOf('_launchRefusal(launch.projectId);\n  if (code)'), 'and it comes before the checks that decide');
    });

    it('a launch that can neither begin nor end is left for the next pass, and does not hold the pass in a loop', async () => {
      try {
        const stuck = await consented();
        const behind = await consented();
        const realBegin = bridgeStore.launches.begin;
        const realEnd = bridgeStore.launches.end;
        const realWrite = bridgeStore.applyRouteWrite;
        let attempts = 0;
        // The store refuses to record a launch as begun.
        bridgeStore.launches.begin = () => { attempts += 1; throw new Error('database is locked'); };
        try {
          const done = await Promise.race([gateway.tick().then(() => 'returned'), new Promise((resolve) => setTimeout(() => resolve('still looping'), 3000))]);
          assert.equal(done, 'returned', 'the pass ends');
          assert.equal(attempts, 2, 'each queued launch was tried once');
          assert.deepEqual([stuck, behind].map((c) => [launchOf(c.routeId).state, launchOf(c.routeId).failureCode]), [['failed', 'launch-error'], ['failed', 'launch-error']], 'a launch that could not be recorded is ended like any other failure, and holds nothing up');
          assert.ok(store.sessions.getActive(stuck.project.id), 'the session it did start is left running');
          // And when not even the ending can be written, the pass stops there and the next one tries again.
          const third = await consented();
          const fourth = await consented();
          // The ending is written by the route write that reports it (#2112), so that is what cannot be written here.
          bridgeStore.launches.end = () => { throw new Error('database is locked'); };
          bridgeStore.applyRouteWrite = (write) => {
            if (write.op === 'launch-failed') throw new Error('database is locked');
            return realWrite(write);
          };
          attempts = 0;
          const again = await Promise.race([gateway.tick().then(() => 'returned'), new Promise((resolve) => setTimeout(() => resolve('still looping'), 3000))]);
          assert.deepEqual([again, attempts], ['returned', 1], 'it does not go on to the one behind');
          assert.deepEqual([launchOf(third.routeId).state, launchOf(fourth.routeId).state], ['queued', 'queued']);
          // The store works again. The next pass comes back to the launch whose failure was never written: it
          // finds the session that consent already started and waits on that one. Nothing is launched twice.
          const startedFor = (project) => launched.filter((args) => args[0].id === project.id).length;
          assert.equal(startedFor(third.project), 1);
          const started = store.sessions.getActive(third.project.id);
          bridgeStore.launches.begin = realBegin; bridgeStore.launches.end = realEnd; bridgeStore.applyRouteWrite = realWrite;
          gateway._reset();
          await gateway.tick();
          const resumed = launchOf(third.routeId);
          assert.deepEqual([resumed.state, resumed.sessionId, resumed.startedSession], ['waiting-ready', started.id, false], 'it waits on the session already there');
          assert.equal(startedFor(third.project), 1, 'one consent, one launch');
          assert.equal(db().prepare("SELECT COUNT(*) AS n FROM bridge_outbound WHERE route_id = ? AND kind = 'failure'").get(third.routeId).n, 0, 'and nobody is told of a failure that did not happen');
          assert.equal(launchOf(fourth.routeId).state, 'queued', 'the one behind still waits its turn');
        } finally { bridgeStore.launches.begin = realBegin; bridgeStore.launches.end = realEnd; bridgeStore.applyRouteWrite = realWrite; }
      } finally { restore(); }
    });

    it('what is asked immediately before the launch is asked after the warm-up, however long that takes', async () => {
      try {
        const lane = (blocked, stopped) => () => ({ ...realControl(), blockingOf: () => ({ blocked, stopped }) });
        /** A consented launch whose warm-up is still going; `during` runs while it waits, then the warm-up ends. */
        const slowly = async (during) => {
          launched = [];
          const c = await consented();
          let finish;
          warming = new Promise((resolve) => { finish = resolve; });
          const pass = gateway.tick();
          await new Promise((resolve) => setImmediate(resolve));
          assert.deepEqual([launched.length, launchOf(c.routeId).state], [0, 'queued'], 'nothing is launched while the warm-up runs');
          await during(c);
          finish();
          warming = null;
          await pass;
          return c;
        };
        // A lane held during the warm-up refuses the launch that follows it.
        const held = await slowly(async () => { gateway._deps.controlState = lane(true, false); });
        gateway._deps.controlState = realControl;
        assert.deepEqual([launchOf(held.routeId).state, launchOf(held.routeId).failureCode, launched.length], ['failed', 'held', 0]);
        // A session started by hand during the warm-up is waited on; nothing is launched beside it.
        let manual;
        const beaten = await slowly(async (c) => { manual = hub.anotherSession(c.project); });
        assert.deepEqual([launchOf(beaten.routeId).state, launchOf(beaten.routeId).sessionId, launchOf(beaten.routeId).startedSession, launched.length], ['waiting-ready', manual.sessionId, false, 0]);
        bridgeStore.launches.end(launchOf(beaten.routeId).launchSeq, 'abandoned', 'test-reset', new Date().toISOString());
        // The bridge switched off during the warm-up: abandoned, not launched.
        const off = await slowly(async () => { assert.equal((await asOperator('POST', '/api/bridge/operator/disable')).status, 200); });
        assert.deepEqual([launchOf(off.routeId).state, launched.length], ['abandoned', 0]);
        assert.equal((await asOperator('POST', '/api/bridge/operator/enable')).status, 200);
        // The message closed during the warm-up: abandoned, not launched.
        const gone = await slowly(async (c) => { assert.equal((await masterWrites(c.routeId, 'close', { expectedVersion: version(c.routeId) })).status, 200); });
        assert.deepEqual([launchOf(gone.routeId).state, launched.length], ['abandoned', 0]);
        // A second pass that comes round while the first is still warming up does not begin the same launch beside it.
        const twice = await slowly(async () => {
          // Raced against a timer: a second pass that joined the first in its warm-up would wait here for ever.
          const second = await Promise.race([gateway.tick(), new Promise((resolve) => setTimeout(() => resolve('waited on the warm-up'), 2000))]);
          assert.notEqual(second, 'waited on the warm-up', 'the second pass does not join the first');
          assert.deepEqual(second.launches, { begun: 0, dispatched: 0 }, 'it leaves the launches to the first');
        });
        assert.deepEqual([launchOf(twice.routeId).state, launched.length], ['waiting-ready', 1], 'launched once');
      } finally { restore(); }
    });

    it('a warm-up that fails launches nothing, and a pass that never returns does not stop the next one for ever', async () => {
      const realWall = gateway._deps.wallClock;
      try {
        gateway._deps.warmForLaunch = async () => { throw new Error('network unreachable'); };
        const cold = await consented();
        await gateway.tick();
        assert.deepEqual([launchOf(cold.routeId).state, launchOf(cold.routeId).failureCode, launched.length], ['failed', 'launch-error', 0], 'not launched on facts it could not gather');

        // The first pass's warm-up never comes back.
        let calls = 0;
        gateway._deps.warmForLaunch = () => { calls += 1; return calls === 1 ? new Promise(() => {}) : Promise.resolve(); };
        const stuck = await consented();
        gateway.tick();
        await new Promise((resolve) => setImmediate(resolve));
        const beside = await Promise.race([gateway.tick(), new Promise((resolve) => setTimeout(() => resolve('waited'), 2000))]);
        assert.deepEqual([beside.launches, launchOf(stuck.routeId).state], [{ begun: 0, dispatched: 0 }, 'queued'], 'for as long as a pass can honestly take, the next leaves it alone');
        // Past that, it is taken to be gone, and the launch is begun by the pass that is alive.
        const wall = realWall();
        gateway._deps.wallClock = () => wall + 6 * 60 * 1000;
        await gateway.tick();
        assert.deepEqual([launchOf(stuck.routeId).state, launched.length], ['waiting-ready', 1]);
      } finally { gateway._deps.wallClock = realWall; gateway._reset(); restore(); }
    });

    it('a project with a session that cannot be reached is not asked about: there is nothing to launch', async () => {
      try {
        const project = stopped();
        const session = hub.anotherSession(project);
        hub.workspaces.delete(String(session.sessionId));
        const routeId = (await operatorWrites(`m${++seq}`, `@${project.name} hello`)).body.routeId;
        const routed = await masterWrites(routeId, 'route', { expectedVersion: version(routeId), to: project.id });
        assert.deepEqual([routed.status, routed.body.code], [409, 'TARGET_OFFLINE'], 'it cannot be sent there');
        const res = await masterWrites(routeId, 'ask-launch', { expectedVersion: version(routeId), project: project.id });
        assert.deepEqual([res.status, res.body.code], [409, 'TARGET_UNREACHABLE'], 'and a launch would start nothing: a session is already running');
        assert.equal(db().prepare('SELECT COUNT(*) AS n FROM bridge_questions WHERE route_id = ?').get(routeId).n, 0);
      } finally { restore(); }
    });

    it('a launch that cannot even be judged does not outlive its wait, and what is behind it then takes its turn', async () => {
      const realMedusa = gateway._deps.medusa;
      try {
        const broken = await consented();
        const behind = await consented();
        await gateway.tick();
        becomesReady(store.sessions.getActive(broken.project.id).id);
        gateway._deps.medusa = () => ({ ...realMedusa(), getStatus: () => { throw new Error('listener map unavailable'); } });
        await gateway.tick();
        assert.deepEqual([launchOf(broken.routeId).state, launchOf(behind.routeId).state], ['waiting-ready', 'queued'], 'inside its wait it is still waited for');
        const realNow = gateway._deps.now;
        const at = new Date(Date.parse(realNow()) + gateway.READY_WAIT_MS + 5000).toISOString();
        gateway._deps.now = () => at;
        try {
          await gateway.tick();
          assert.deepEqual([launchOf(broken.routeId).state, launchOf(broken.routeId).failureCode], ['failed', 'launch-error']);
        } finally { gateway._deps.now = realNow; }
        gateway._deps.medusa = realMedusa;
        await gateway.tick();
        assert.equal(launchOf(behind.routeId).state, 'waiting-ready', 'the next in line is no longer held up');
      } finally { gateway._deps.medusa = realMedusa; restore(); }
    });

    it('the three verbs over the command line', async () => {
      try {
        const project = stopped();
        const routeId = (await operatorWrites(`m${++seq}`, `@${project.name} please run the nightly`)).body.routeId;
        const offline = await tc(['bridge', 'route', routeId, '--version', String(version(routeId)), '--to', String(project.id)]);
        assert.deepEqual([offline.code, /refused \[TARGET_OFFLINE\]/.test(offline.stderr)], [2, true]);
        const ask = await tc(['bridge', 'ask-launch', routeId, '--version', String(version(routeId)), '--project', project.name]);
        assert.equal(ask.code, 0, ask.stderr);
        assert.match(ask.stdout, /The operator is being asked whether to launch a session for route .*; the message stays held and nothing is launched; now v\d+\./);
        assert.match((await tc(['bridge', 'read', routeId])).stdout, new RegExp(`you asked the operator whether to launch project #${project.id} for it`));
        const item = about(await claimAll(), routeId).find((i) => i.kind === 'question');
        assert.equal((await ackItem(item, 'dl-cli')).status, 200);
        const reply = await operatorReplies('dl-cli', 'yes');
        const bare = await tc(['bridge', 'launch', routeId, '--version', String(version(routeId))]);
        assert.deepEqual([bare.code, /needs --answered-by/.test(bare.stderr)], [1, true], 'a launch names the reply it rests on');
        const go = await tc(['bridge', 'launch', routeId, '--version', String(version(routeId)), '--answered-by', reply]);
        assert.equal(go.code, 0, go.stderr);
        assert.match(go.stdout, /the server will launch the session in turn, wait until it is ready, and then send the message on\. Nothing is sent yet/);
        assert.deepEqual(launched, [], 'the command line launched nothing either');

        const other = await asked();
        const no = await operatorReplies(other.posted, 'cancel');
        const declined = await tc(['bridge', 'decline', other.routeId, '--version', String(version(other.routeId)), '--answered-by', no]);
        assert.equal(declined.code, 0, declined.stderr);
        assert.match(declined.stdout, /is closed on the operator's answer: nothing was launched and nothing was sent on/);
        const stray = await tc(['bridge', 'ask', routeId, '--version', '1', '--text', 'x', '--project', 'y']);
        assert.deepEqual([stray.code, /unexpected --project/.test(stray.stderr)], [1, true]);
      } finally { restore(); }
    });
  });

  describe('what the bridge may reach', () => {
    const version = (id) => bridgeStore.routes.get(id).version;
    const db = () => store.getDb();
    const suggestion = (routeId) => bridgeStore.audit.suggestionFor(routeId);
    let realScope;
    beforeEach(() => { realScope = bridgeReach._deps.masterScope; });
    const restore = () => { bridgeReach._deps.masterScope = realScope; };
    /** An inbound, held, as it arrived. */
    const inbound = async (text) => (await operatorWrites(`m${++seq}`, text)).body.routeId;
    /** A Master route write that must be refused and leave the route exactly as it was. */
    const refusedRoute = async (routeId, to, status, code, why) => {
      const before = JSON.stringify(bridgeStore.routes.get(routeId));
      const sent = hub.fromGateway().length;
      const res = await masterWrites(routeId, 'route', { expectedVersion: version(routeId), to });
      assert.deepEqual([res.status, res.body.code], [status, code], why);
      assert.equal(JSON.stringify(bridgeStore.routes.get(routeId)), before, `${why}: the message is still held as it was`);
      assert.equal(hub.fromGateway().length, sent, `${why}: nothing was sent`);
    };

    it('a new project is reachable with no step, by its name, its slug or its id, and what is suggested is what can be routed to', async () => {
      try {
        // No spaces: the stand-in Hub makes a workspace id of the name. The underscores still make its slug differ.
        const fresh = liveProject(`Fresh_Project_${++seq}`);
        const slug = bridgeReach.slugOf(fresh.project.name);
        const byName = await inbound(`@${slug} are you there?`);
        assert.deepEqual(suggestion(byName), { by: 'alias', to: 'project', projectId: fresh.project.id, reason: null }, 'a project is addressed by its slug');
        for (const to of [slug, fresh.project.name, fresh.project.id]) {
          const routeId = await inbound('@nobody-in-particular hello');
          const res = await masterWrites(routeId, 'route', { expectedVersion: version(routeId), to });
          assert.deepEqual([res.status, res.body.code || null, res.body.route && res.body.route.state, res.body.route && res.body.route.destination && res.body.route.destination.projectId], [200, null, 'routed', fresh.project.id], `${JSON.stringify(to)}: ${res.body.route && res.body.route.failureCode}`);
        }
        const listed = await call('GET', '/api/bridge/master/destinations', { headers: asMaster() });
        assert.equal(listed.status, 200);
        assert.deepEqual(listed.body.destinations.find((d) => d.projectId === fresh.project.id), { projectId: fresh.project.id, name: fresh.project.name, slug, nicknames: [], live: 'live' });
        assert.deepEqual(listed.body.scope, { kind: 'all' });
      } finally { restore(); }
    });

    it('opting a project out is the signed-in operator\'s alone, takes effect at once, and is undone the same way', async () => {
      try {
        const target = liveProject(`Reach${++seq}`);
        // Not the Master, not the helper, not a caller who only looks like the dashboard.
        for (const [who, headers] of [['the Master', asMaster()], ['the helper', asHelper()], ['nobody', {}]]) {
          const res = await call('POST', '/api/bridge/operator/optouts', { headers, body: { project: target.project.id } });
          assert.ok([401, 403].includes(res.status), `${who}: ${res.status}`);
        }
        const ambient = await bridgeApi.handle(bridgeApi.routeFor('POST', '/api/bridge/operator/optouts'), { req: AMBIENT, headers: {}, body: { project: target.project.id } });
        assert.ok([401, 403].includes(ambient.status), 'a dashboard-shaped request with no signed-in operator');
        assert.equal(bridgeStore.optouts.has(target.project.id), false, 'none of them changed anything');
        for (const project of [undefined, 'by-name', 0, -1, 1.5, 99999999]) {
          const bad = await asOperator('POST', '/api/bridge/operator/optouts', { body: { project } });
          assert.deepEqual([bad.status, bad.body.code], [400, 'UNKNOWN_PROJECT'], JSON.stringify(project));
        }

        const out = await asOperator('POST', '/api/bridge/operator/optouts', { body: { project: target.project.id } });
        assert.deepEqual([out.status, out.body], [200, { projectId: target.project.id, optedOut: true, changed: true }]);
        const again = await asOperator('POST', '/api/bridge/operator/optouts', { body: { project: target.project.id } });
        assert.deepEqual([again.status, again.body.changed], [200, false]);
        assert.equal(db().prepare("SELECT COUNT(*) AS n FROM bridge_audit WHERE op = 'optout-set' AND detail_json LIKE ?").get(`%"projectId":${target.project.id},%`).n, 1, 'audited once, by who did it');

        // At once: not suggested, not routable, not launchable, not listed.
        const addressed = await inbound(`@${target.project.name} hello`);
        assert.deepEqual(suggestion(addressed), { by: null, to: null, projectId: null, reason: 'address-out-of-reach' }, 'not suggested, and said to be out of reach, not unknown');
        await refusedRoute(addressed, target.project.id, 409, 'DESTINATION_OPTED_OUT', 'by id');
        await refusedRoute(addressed, target.project.name, 409, 'DESTINATION_OPTED_OUT', 'by name');
        const ask = await masterWrites(addressed, 'ask-launch', { expectedVersion: version(addressed), project: target.project.id });
        assert.deepEqual([ask.status, ask.body.code], [409, 'DESTINATION_OPTED_OUT']);
        const pin = await masterWrites(addressed, 'pin', { expectedVersion: version(addressed), to: target.project.id });
        assert.deepEqual([pin.status, pin.body.code], [409, 'DESTINATION_OPTED_OUT'], 'nor pinned to');
        const listed = (await call('GET', '/api/bridge/master/destinations', { headers: asMaster() })).body;
        assert.equal(listed.destinations.some((d) => d.projectId === target.project.id), false);
        assert.ok(listed.optedOut >= 1, 'the Master is told that some are out of reach, and not which');
        const status = (await asOperator('GET', '/api/bridge/operator/status')).body;
        assert.deepEqual(status.reach.optouts.filter((o) => o.projectId === target.project.id).map((o) => o.name), [target.project.name]);
        assert.equal(status.reach.reachable.some((p) => p.projectId === target.project.id), false);

        // Undone by the operator, and only by the operator.
        const stranger = await call('DELETE', `/api/bridge/operator/optouts/${target.project.id}`, { headers: asMaster() });
        assert.ok([401, 403].includes(stranger.status));
        const back = await asOperator('DELETE', '/api/bridge/operator/optouts/:projectId', { params: { projectId: String(target.project.id) } });
        assert.deepEqual([back.status, back.body], [200, { projectId: target.project.id, optedOut: false }]);
        const twice = await asOperator('DELETE', '/api/bridge/operator/optouts/:projectId', { params: { projectId: String(target.project.id) } });
        assert.deepEqual([twice.status, twice.body.code], [404, 'OPTOUT_NOT_FOUND']);
        for (const projectId of ['abc', '', '0', '1e3']) {
          const bad = await asOperator('DELETE', '/api/bridge/operator/optouts/:projectId', { params: { projectId } });
          assert.deepEqual([bad.status, bad.body.code], [404, 'OPTOUT_NOT_FOUND'], projectId);
        }
        const routed = await masterWrites(addressed, 'route', { expectedVersion: version(addressed), to: target.project.id });
        assert.deepEqual([routed.status, routed.body.route.state], [200, 'routed'], 'within reach again at once');
      } finally { restore(); }
    });

    it('the Master\'s scope bounds what it may route to, and a scope that cannot be resolved reaches nothing and says so', async () => {
      try {
        const inside = liveProject(`Inside${++seq}`);
        const outside = liveProject(`Outside${++seq}`);
        const group = store.projectGroups.create({ name: `Scope${++seq}` });
        store.projectGroups.addMember(group.id, inside.project.id);
        bridgeReach._deps.masterScope = () => ({ type: 'group', groupId: group.id });
        const routeId = await inbound(`@${outside.project.name} hello`);
        assert.equal(suggestion(routeId).reason, 'address-out-of-reach', 'a project outside the scope is not even suggested');
        await refusedRoute(routeId, outside.project.id, 409, 'DESTINATION_OUT_OF_SCOPE', 'outside the scope');
        const listed = (await call('GET', '/api/bridge/master/destinations', { headers: asMaster() })).body;
        assert.deepEqual([listed.scope, listed.destinations.map((d) => d.projectId)], [{ kind: 'group', groupName: group.name }, [inside.project.id]]);
        assert.match((await tc(['bridge', 'destinations'])).stdout, new RegExp(`1 reachable project\\(s\\) \\(your scope, the ${group.name} group\\), worked out just now\\.`));

        // The group is deleted: nothing is reachable, and it is not shown as an empty fleet.
        store.projectGroups.delete(group.id);
        await refusedRoute(routeId, inside.project.id, 409, 'SCOPE_UNRESOLVED', 'scope unresolved, even for a project that was inside');
        const toMaster = await inbound('@master are you there?');
        assert.equal((await masterWrites(toMaster, 'route', { expectedVersion: version(toMaster), to: 'master' })).status, 200, 'the Master itself is always reachable');
        const empty = (await call('GET', '/api/bridge/master/destinations', { headers: asMaster() })).body;
        const unresolved = { kind: 'unresolved', cause: 'group-missing', why: 'it names a project group that no longer exists' };
        assert.deepEqual([empty.scope, empty.destinations], [unresolved, []]);
        const refusal = await masterWrites(routeId, 'route', { expectedVersion: version(routeId), to: inside.project.id });
        assert.match(refusal.body.error, /The Project Master's scope cannot be resolved \(it names a project group that no longer exists\), so no project is reachable\./, 'the refusal says which thing is wrong');
        const shown = await tc(['bridge', 'destinations']);
        assert.match(shown.stdout, /^SCOPE UNRESOLVED: your scope cannot be resolved \(it names a project group that no longer exists\), so the bridge reaches no project at all\.\nThis is not an empty fleet\./);
        assert.match((await tc(['bridge', 'status'])).stdout, /SCOPE UNRESOLVED: your scope cannot be resolved \(it names a project group that no longer exists\), so the bridge reaches no project\./);
        assert.deepEqual((await asOperator('GET', '/api/bridge/operator/status')).body.reach.scope, unresolved);

        // Recorded once when it happens and once when it is put right, however many passes run.
        const scopeRows = () => db().prepare("SELECT outcome FROM bridge_audit WHERE op = 'scope' ORDER BY audit_seq").all().map((r) => r.outcome);
        const before = scopeRows().length;
        for (let i = 0; i < 3; i++) await gateway.tick();
        assert.deepEqual(scopeRows().slice(before), ['scope-unresolved']);
        assert.equal(JSON.parse(db().prepare("SELECT detail_json FROM bridge_audit WHERE op = 'scope' ORDER BY audit_seq DESC LIMIT 1").get().detail_json).cause, 'group-missing', 'with its cause');
        restore();
        for (let i = 0; i < 3; i++) await gateway.tick();
        assert.deepEqual(scopeRows().slice(before), ['scope-unresolved', 'scope-resolved']);
      } finally { restore(); }
    });

    it('a reply or a pin that points at a project out of reach suggests nothing, and nothing is stored that could never be routed to', async () => {
      try {
        const target = liveProject(`Gone${++seq}`);
        // A message routed there while it was reachable, and a pin on a conversation of its own.
        const earlier = (await operatorSays(`m${++seq}`, `@${target.project.name} first`)).body;
        assert.equal(earlier.state, 'routed');
        const thread = `thread${++seq}`;
        const pinned = await call('POST', '/api/bridge/helper/inbound', { headers: asHelper(), body: { externalId: `m${++seq}`, ...ALLOWED, threadId: thread, text: 'in a thread of its own' } });
        const pin = await masterWrites(pinned.body.routeId, 'pin', { expectedVersion: version(pinned.body.routeId), to: target.project.id });
        assert.equal(pin.status, 200, JSON.stringify(pin.body));
        const reply = async () => (await call('POST', '/api/bridge/helper/inbound', { headers: asHelper(), body: { externalId: `m${++seq}`, ...ALLOWED, replyToExternalId: bridgeStore.routes.get(earlier.routeId).externalId, text: 'and again' } })).body.routeId;
        const inThread = async () => (await call('POST', '/api/bridge/helper/inbound', { headers: asHelper(), body: { externalId: `m${++seq}`, ...ALLOWED, threadId: thread, text: 'more in the thread' } })).body.routeId;
        assert.deepEqual([suggestion(await reply()), suggestion(await inThread())].map((s) => [s.by, s.projectId]), [['reply-inheritance', target.project.id], ['pin', target.project.id]], 'while it is reachable, both are suggested');

        assert.equal((await asOperator('POST', '/api/bridge/operator/optouts', { body: { project: target.project.id } })).status, 200);
        const none = { by: null, to: null, projectId: null, reason: 'destination-out-of-reach' };
        assert.deepEqual([suggestion(await reply()), suggestion(await inThread())], [none, none], 'out of reach, neither is: a suggestion is always something that can be routed to');
        // The operator's own nicknames and pins are held to the same rule, by the same reason.
        for (const [apiPath, body] of [['/api/bridge/operator/aliases', { alias: `gone${seq}`, to: target.project.id }], ['/api/bridge/operator/pins', { conversationKey: null, to: target.project.id }]]) {
          const res = await asOperator('POST', apiPath, { body });
          assert.deepEqual([res.status, res.body.code], [409, 'DESTINATION_OPTED_OUT'], apiPath);
        }
        assert.equal(bridgeStore.aliases.get(`gone${seq}`), null);
        assert.equal((await asOperator('DELETE', '/api/bridge/operator/optouts/:projectId', { params: { projectId: String(target.project.id) } })).status, 200);
      } finally { restore(); }
    });

    it('a Master write refused for where it points is on the audit, by its code, and a route already decided is asked again at the send', async () => {
      try {
        const target = liveProject(`Audited${++seq}`);
        const routeId = await inbound('@nobody-known hello');
        const rows = () => db().prepare("SELECT op, outcome, actor FROM bridge_audit WHERE route_id = ? AND actor = 'master' ORDER BY audit_seq").all(routeId).map((r) => `${r.op}:${r.outcome}`);
        assert.equal((await asOperator('POST', '/api/bridge/operator/optouts', { body: { project: target.project.id } })).status, 200);
        await refusedRoute(routeId, target.project.id, 409, 'DESTINATION_OPTED_OUT', 'opted out');
        await refusedRoute(routeId, 'No Such Project', 400, 'UNKNOWN_DESTINATION', 'unknown');
        assert.equal((await masterWrites(routeId, 'ask-launch', { expectedVersion: version(routeId), project: target.project.id })).status, 409);
        assert.equal((await masterWrites(routeId, 'pin', { expectedVersion: version(routeId), to: target.project.id })).status, 409);
        assert.deepEqual(rows(), ['route:destination-opted-out', 'route:unknown-destination', 'ask-launch:destination-opted-out', 'pin:destination-opted-out'], 'every Master write leaves a row, applied or refused');
        assert.equal((await asOperator('DELETE', '/api/bridge/operator/optouts/:projectId', { params: { projectId: String(target.project.id) } })).status, 200);

        // Decided while reachable, opted out before the send (a restart falls here): not sent.
        const decided = bridgeStore.applyRouteWrite({
          op: 'route', requestId: `req-late-${++seq}-0000`, routeId, expectedVersion: version(routeId), actor: 'master', proof: 'master-launch', masterGeneration,
          change: () => ({ set: { state: 'accepted', resolved_by: 'master', destination_kind: 'project', destination_project_id: target.project.id, resolved_generation: masterGeneration, failure_code: null } })
        });
        assert.equal(decided.outcome, 'applied');
        assert.equal((await asOperator('POST', '/api/bridge/operator/optouts', { body: { project: target.project.id } })).status, 200);
        const sent = hub.fromGateway().length;
        await gateway.advance(routeId);
        assert.deepEqual([bridgeStore.routes.get(routeId).state, bridgeStore.routes.get(routeId).failureCode, hub.fromGateway().length], ['awaiting-master', 'destination-out-of-reach', sent]);
        assert.equal((await asOperator('DELETE', '/api/bridge/operator/optouts/:projectId', { params: { projectId: String(target.project.id) } })).status, 200);
      } finally { restore(); }
    });

    it('a name that means two things, and a project with two live sessions, are never guessed at', async () => {
      try {
        const alpha = liveProject(`Twin${++seq}`);
        const beta = liveProject(`Other${++seq}`);
        // A nickname may not be given a name a reachable project already has: that is how a name comes to mean two things.
        const clash = await asOperator('POST', '/api/bridge/operator/aliases', { body: { alias: beta.project.name, to: alpha.project.id } });
        assert.deepEqual([clash.status, clash.body.code], [409, 'NICKNAME_COLLIDES']);
        // It can still happen the other way round, when a project is created or renamed onto an existing nickname. Then nothing is guessed.
        bridgeStore.aliases.set(beta.project.name.toLowerCase(), { kind: 'project', projectId: alpha.project.id });
        const routeId = await inbound(`@${beta.project.name} which of you?`);
        assert.equal(suggestion(routeId).reason, 'address-ambiguous');
        await refusedRoute(routeId, beta.project.name, 409, 'DESTINATION_AMBIGUOUS', 'a name that is one project\'s and another\'s nickname');
        assert.equal((await asOperator('DELETE', '/api/bridge/operator/aliases/:alias', { params: { alias: beta.project.name } })).status, 200);
        assert.equal(suggestion(await inbound(`@no-such-thing-${seq} hello`)).reason, 'address-unresolved', 'a name that is nobody\'s is still just unknown');

        // A second live session of one project: an anomaly. Nothing is sent to either.
        const second = hub.anotherSession(alpha.project);
        await refusedRoute(routeId, alpha.project.id, 409, 'TARGET_AMBIGUOUS', 'two live sessions');
        const ask = await masterWrites(routeId, 'ask-launch', { expectedVersion: version(routeId), project: alpha.project.id });
        assert.deepEqual([ask.status, ask.body.code], [409, 'TARGET_AMBIGUOUS'], 'and there is nothing to launch');
        const listed = (await call('GET', '/api/bridge/master/destinations', { headers: asMaster() })).body;
        assert.equal(listed.destinations.find((d) => d.projectId === alpha.project.id).live, 'several-live');
        assert.match((await tc(['bridge', 'destinations'])).stdout, new RegExp(`#${alpha.project.id}  ${alpha.project.name}  MORE THAN ONE LIVE SESSION \\(nothing is sent until the operator says which is meant\\)`));
        // It becomes two between the Master's decision and the send: bounced, to neither.
        store.sessions.kill(second.sessionId, 'ended');
        const late = await inbound(`@${alpha.project.name} and now?`);
        const decided = bridgeStore.applyRouteWrite({
          op: 'route', requestId: `req-two-${++seq}-0000`, routeId: late, expectedVersion: version(late), actor: 'master', proof: 'master-launch', masterGeneration,
          change: () => ({ set: { state: 'accepted', resolved_by: 'master', destination_kind: 'project', destination_project_id: alpha.project.id, resolved_generation: masterGeneration, failure_code: null } })
        });
        assert.equal(decided.outcome, 'applied');
        const third = hub.anotherSession(alpha.project);
        const sent = hub.fromGateway().length;
        await gateway.advance(late);
        assert.deepEqual([bridgeStore.routes.get(late).state, bridgeStore.routes.get(late).failureCode], ['awaiting-master', 'target-ambiguous']);
        assert.equal(hub.fromGateway().length, sent, 'sent to neither');
        store.sessions.kill(third.sessionId, 'ended');
      } finally { restore(); }
    });

    it('with two sessions and one listener, the message goes to the one that is listening, whichever is newer', async () => {
      try {
        const older = liveProject(`Pair${++seq}`);
        const newer = hub.anotherSession(older.project);
        hub.workspaces.delete(String(newer.sessionId));
        assert.equal(store.sessions.getActive(older.project.id).id, newer.sessionId, 'precondition: the newest session is the one that cannot be sent to');
        const routeId = await inbound(`@${older.project.name} which of you hears this?`);
        const routed = await masterWrites(routeId, 'route', { expectedVersion: version(routeId), to: older.project.id });
        assert.deepEqual([routed.status, routed.body.route.state], [200, 'routed'], JSON.stringify(routed.body));
        const sent = hub.fromGateway().filter((m) => m.message.includes('which of you hears this?'));
        assert.deepEqual(sent.map((m) => m.to), [older.workspaceId], 'to the session the server holds a listener for');
        const proof = db().prepare("SELECT target_session_id, target_launch_id FROM bridge_route_proofs WHERE route_id = ? AND direction = 'to-target'").get(routeId);
        assert.deepEqual([Number(proof.target_session_id), proof.target_launch_id], [older.sessionId, older.launchId], 'and the proof a reply is held to names that session');
        store.sessions.kill(newer.sessionId, 'ended');
      } finally { restore(); }
    });

    it('`tc bridge destinations` says how each project is named and how it stands', async () => {
      try {
        const live = liveProject(`Listed_One_${++seq}`);
        const stopped = store.projects.create({ name: `Listed Two ${++seq}`, path: path.join(tmpDir, `listed-two-${seq}`) });
        assert.equal((await asOperator('POST', '/api/bridge/operator/aliases', { body: { alias: `nick${seq}`, to: live.project.id } })).status, 200);
        const out = (await tc(['bridge', 'destinations'])).stdout;
        assert.match(out, /reachable project\(s\) \(every project on this install\), worked out just now\./);
        assert.ok(out.includes(`  #${live.project.id}  ${live.project.name}  running\n      named by @${live.project.name}, @${bridgeReach.slugOf(live.project.name)}, @nick${seq} or its id`), out);
        assert.ok(out.includes(`  #${stopped.id}  ${stopped.name}  NOT RUNNING (ask the operator before it is launched: tc bridge ask-launch)`), out);
        assert.match(out, /`master` always means you\. A name is only ever a suggestion: nothing is sent until you route it\.\n$/);
        const extra = await tc(['bridge', 'destinations', 'all']);
        assert.equal(extra.code, 1, 'it takes no argument');
      } finally { restore(); }
    });
  });

  describe('nicknames, asked for in conversation', () => {
    const version = (id) => bridgeStore.routes.get(id).version;
    const db = () => store.getDb();
    const suggestion = (routeId) => bridgeStore.audit.suggestionFor(routeId);
    const about = (items, routeId) => items.filter((i) => i.inReplyTo && i.inReplyTo.externalId === bridgeStore.routes.get(routeId).externalId);
    const claimAll = async () => {
      const all = [];
      for (let pass = 0; pass < 10; pass++) {
        const { items } = (await claim()).body;
        if (!items.length) break;
        all.push(...items);
      }
      return all;
    };
    /** A Master nickname write. */
    const nick = (apiPath, body) => call('POST', `/api/bridge/master/nicknames${apiPath}`, { headers: asMaster(), body: { requestId: `req-nick-${++seq}-0000`, ...body } });
    /** The operator writes to the Master, and the Master takes the message as one for itself. */
    const instruction = async (text) => {
      const routeId = (await operatorWrites(`m${++seq}`, text)).body.routeId;
      const routed = await masterWrites(routeId, 'route', { expectedVersion: version(routeId), to: 'master' });
      assert.deepEqual([routed.status, routed.body.route.state, routed.body.route.destination.kind], [200, 'routed', 'master'], JSON.stringify(routed.body));
      return routeId;
    };
    const operatorReplies = async (to, text) => {
      const res = await call('POST', '/api/bridge/helper/inbound', { headers: asHelper(), body: { externalId: `m${++seq}`, ...ALLOWED, replyToExternalId: to, text } });
      assert.equal(res.status, 202, JSON.stringify(res.body));
      return res.body.routeId;
    };
    const names = () => JSON.stringify(bridgeStore.aliases.records());

    it('"remember @X means Y": stored on the operator\'s own message, recorded with who and when, and still only a suggestion', async () => {
      const target = liveProject(`Architect${++seq}`);
      const name = `TC-ARC${seq}`;
      const asked = await instruction(`@master remember @${name} means ${target.project.name}`);
      const sentBefore = hub.fromGateway().length;
      const stored = await nick('', { name: `@${name}`, to: target.project.id, answeredBy: asked });
      assert.deepEqual([stored.status, stored.body.outcome, stored.body.nickname, stored.body.projectId, stored.body.via], [200, 'applied', name.toLowerCase(), target.project.id, 'instruction'], JSON.stringify(stored.body));
      const record = bridgeStore.aliases.record(name.toLowerCase());
      assert.deepEqual([record.display, record.destination, record.createdBy, record.changedBy, record.confirmedRouteId],
        [name, { kind: 'project', projectId: target.project.id }, 'master', 'master', asked], 'as typed, pointing at the project id, by the Master, on that message');
      assert.ok(record.changedAt && record.createdAt);
      assert.equal(hub.fromGateway().length, sentBefore, 'storing a name sends nothing anywhere');
      // The audit names the nickname, the target and the message. None of the message's words.
      const audit = db().prepare("SELECT outcome, route_id, detail_json FROM bridge_audit WHERE op = 'nickname-set' AND route_id = ?").get(asked);
      assert.deepEqual([audit.outcome, JSON.parse(audit.detail_json)], ['applied', { nickname: name.toLowerCase(), to: 'project', projectId: target.project.id, via: 'instruction', questionId: null }]);
      assert.ok(!/remember|means/.test(audit.detail_json));

      // A message addressed by it is suggested for that project, and goes nowhere until the Master routes it.
      const addressed = (await operatorWrites(`m${++seq}`, `@${name.toUpperCase()} are you there?`)).body.routeId;
      assert.deepEqual(suggestion(addressed), { by: 'alias', to: 'project', projectId: target.project.id, reason: null }, 'without regard to case');
      assert.equal(bridgeStore.routes.get(addressed).state, 'awaiting-master');
      assert.equal(hub.fromGateway().length, sentBefore, 'a nickname is a suggestion: it routes nothing');
      const routed = await masterWrites(addressed, 'route', { expectedVersion: version(addressed), to: name.toLowerCase() });
      assert.deepEqual([routed.status, routed.body.route.destination.projectId], [200, target.project.id], 'and the Master may route by the nickname');

      // The Master tells the operator in the same conversation: an answer on the instructing message.
      const told = await masterWrites(asked, 'answer', { expectedVersion: version(asked), text: `Stored: @${name.toLowerCase()} is ${target.project.name}.` });
      assert.equal(told.status, 200, JSON.stringify(told.body));
      assert.deepEqual(about(await claimAll(), asked).filter((i) => i.kind === 'reply').map((i) => i.text), [`Stored: @${name.toLowerCase()} is ${target.project.name}.`]);

      // Listed and explained.
      const listed = (await call('GET', '/api/bridge/master/nicknames', { headers: asMaster() })).body.nicknames.find((n) => n.nickname === name.toLowerCase());
      assert.deepEqual([listed.display, listed.destination, listed.reachable, listed.live, listed.changedBy, listed.confirmedRouteId],
        [name, { kind: 'project', projectId: target.project.id, name: target.project.name }, true, 'live', 'master', asked]);
      const one = await call('GET', `/api/bridge/master/nicknames/${name.toLowerCase()}`, { headers: asMaster() });
      assert.deepEqual([one.status, one.body.nickname.nickname], [200, name.toLowerCase()]);
      assert.equal((await call('GET', '/api/bridge/master/nicknames/no-such-nickname', { headers: asMaster() })).status, 404);
    });

    it('one operator message authorises one change, and a repeat of the same request changes nothing', async () => {
      const target = liveProject(`Once${++seq}`);
      const asked = await instruction(`@master remember @once${seq} means ${target.project.name}`);
      const body = { requestId: `req-nick-once-${seq}-0000`, name: `once${seq}`, to: target.project.id, answeredBy: asked };
      const first = await call('POST', '/api/bridge/master/nicknames', { headers: asMaster(), body });
      assert.deepEqual([first.status, first.body.replayed], [200, false]);
      const again = await call('POST', '/api/bridge/master/nicknames', { headers: asMaster(), body });
      assert.deepEqual([again.status, again.body.replayed, again.body.nickname], [200, true, `once${seq}`], 'the same request, answered as it was the first time');
      const before = names();
      for (const [apiPath, more] of [['', { name: `twice${seq}`, to: target.project.id }], [`/once${seq}/rename`, { to: `renamed${seq}` }], [`/once${seq}/forget`, {}]]) {
        const res = await nick(apiPath, { ...more, answeredBy: asked });
        assert.deepEqual([res.status, res.body.code], [409, 'INSTRUCTION_USED'], apiPath || 'set');
      }
      assert.equal(names(), before, 'nothing more was stored, renamed or forgotten on that one message');
      assert.equal(db().prepare("SELECT COUNT(*) AS n FROM bridge_audit WHERE route_id = ? AND op LIKE 'nickname-%' AND outcome = 'applied'").get(asked).n, 1);
    });

    it('only a message the operator sent to the Master, or their reply to its question, authorises anything', async () => {
      const target = liveProject(`Auth${++seq}`);
      const before = names();
      const refused = async (answeredBy, status, code, why) => {
        const res = await nick('', { name: `auth${++seq}`, to: target.project.id, answeredBy });
        assert.deepEqual([res.status, res.body.code], [status, code], why);
        assert.equal(names(), before, `${why}: nothing was stored`);
      };
      // Still waiting for the Master: no routing decision has made it the Master's message.
      const waiting = (await operatorWrites(`m${++seq}`, '@master remember @x means y')).body.routeId;
      await refused(waiting, 409, 'NOT_AN_INSTRUCTION', 'a message the Master has not taken');
      // Routed to a project: it was not for the Master.
      const elsewhere = (await operatorSays(`m${++seq}`, `@${target.project.name} remember @x means y`)).body.routeId;
      await refused(elsewhere, 409, 'NOT_AN_INSTRUCTION', 'a message that went to a project');
      // Closed.
      const closed = await instruction('@master remember @x means y');
      assert.equal((await masterWrites(closed, 'close', { expectedVersion: version(closed) })).status, 200);
      await refused(closed, 409, 'NOT_AN_INSTRUCTION', 'a closed message');
      await refused('rt_no_such_route', 409, 'NOT_AN_INSTRUCTION', 'no such message');
      for (const bad of [undefined, '', 'has spaces', 7]) await refused(bad, 400, 'BAD_ANSWERED_BY', JSON.stringify(bad));
      // Taken by the Master, but never written to @master: to nobody, or to a nickname that means the Master.
      const unaddressed = (await operatorWrites(`m${++seq}`, 'remember @x means y')).body.routeId;
      assert.notEqual(suggestion(unaddressed).by, 'alias', 'it carries no address');
      assert.equal((await masterWrites(unaddressed, 'route', { expectedVersion: version(unaddressed), to: 'master' })).status, 200);
      await refused(unaddressed, 409, 'NOT_AN_INSTRUCTION', 'a message addressed to nobody');
      const boss = `boss${++seq}`;
      bridgeStore.aliases.set(boss, { kind: 'master', projectId: null });
      const viaNickname = (await operatorWrites(`m${++seq}`, `@${boss} remember @x means y`)).body.routeId;
      assert.deepEqual([suggestion(viaNickname).by, suggestion(viaNickname).to], ['alias', 'master']);
      assert.equal((await masterWrites(viaNickname, 'route', { expectedVersion: version(viaNickname), to: 'master' })).status, 200);
      const namesWithBoss = names();
      const viaBoss = await nick('', { name: `auth${++seq}`, to: target.project.id, answeredBy: viaNickname });
      assert.deepEqual([viaBoss.status, viaBoss.body.code], [409, 'NOT_AN_INSTRUCTION'], 'a nickname that means the Master is not @master');
      assert.equal(names(), namesWithBoss);
      bridgeStore.aliases.remove(boss);
      // Written to @master in any case of letters is written to @master.
      const shouted = await instruction(`@MASTER remember @x means ${target.project.name}`);
      const keptName = `auth${++seq}`;
      const kept = await nick('', { name: keptName, to: target.project.id, answeredBy: shouted });
      assert.equal(kept.status, 200, JSON.stringify(kept.body));
      assert.equal((await nick(`/${keptName}/forget`, { answeredBy: await instruction(`@master forget @${keptName}`) })).status, 200);
      // A reply to a launch question is an answer about launching, and nothing else.
      const stopped = store.projects.create({ name: `AuthStopped${++seq}`, path: path.join(tmpDir, `auth-stopped-${seq}`) });
      const held = (await operatorWrites(`m${++seq}`, `@master run ${stopped.name}`)).body.routeId;
      assert.equal((await masterWrites(held, 'ask-launch', { expectedVersion: version(held), project: stopped.id })).status, 200);
      const question = about(await claimAll(), held).find((i) => i.kind === 'question');
      assert.equal((await ackItem(question, `dn${++seq}`)).status, 200);
      const yes = await operatorReplies(`dn${seq}`, 'yes, and call it @x');
      await refused(yes, 409, 'QUESTION_PURPOSE', 'a reply to a launch question');
      // No write without a request id, and none by anyone but the Master.
      const bare = await call('POST', '/api/bridge/master/nicknames', { headers: asMaster(), body: { name: 'x', to: target.project.id, answeredBy: closed } });
      assert.deepEqual([bare.status, bare.body.code], [400, 'REQUEST_ID_REQUIRED']);
      for (const headers of [asHelper(), {}]) {
        const res = await call('POST', '/api/bridge/master/nicknames', { headers, body: { requestId: 'req-nick-stranger-0000', name: 'x', to: target.project.id, answeredBy: closed } });
        assert.ok([401, 403].includes(res.status));
      }
      assert.equal(names(), before);
    });

    it('a message written to a project gains no authority over nicknames by being asked about (Architect ruling)', async () => {
      const target = liveProject(`Borrow${++seq}`);
      const before = names();
      /** The Master asks a clarifying question about a held message, and the operator replies to it. */
      const askedAndAnswered = async (routeId, answer) => {
        assert.equal((await masterWrites(routeId, 'ask', { expectedVersion: version(routeId), text: 'Which did you mean?' })).status, 200);
        const question = about(await claimAll(), routeId).filter((i) => i.kind === 'question').pop();
        assert.equal((await ackItem(question, `dn${++seq}`)).status, 200);
        return operatorReplies(`dn${seq}`, answer);
      };
      // Written to a project. The Master asks about it; the reply is a real, correlated answer to a real question.
      const toProject = (await operatorWrites(`m${++seq}`, `@${target.project.name} carry on, and call yourself @bo`)).body.routeId;
      assert.deepEqual([suggestion(toProject).by, suggestion(toProject).to], ['alias', 'project']);
      // The reply opening with @master makes no difference: it is the message asked about that is read.
      const reply = await askedAndAnswered(toProject, '@master yes, @bo');
      for (const [apiPath, body] of [['', { name: `bo${seq}`, to: target.project.id }], ['/nosuch/rename', { to: `bo${seq}` }], ['/nosuch/forget', {}]]) {
        const res = await nick(apiPath, { ...body, answeredBy: reply });
        assert.deepEqual([res.status, res.body.code], [409, 'NOT_AN_INSTRUCTION'], apiPath || 'set');
      }
      assert.equal(names(), before, 'nothing was stored');
      // Only the gateway's own record of the address counts. Under a route id with no other record, so that the
      // row in question is the only one there is to read: another writer's is not it, and the gateway's is.
      const marked = { by: 'alias', to: 'master', projectId: null, reason: null, reserved: true };
      const ghost = `rt_only_row_${++seq}`;
      bridgeStore.audit.append({ op: 'suggest', requestId: `forged-suggest-${seq}`, actor: 'master', proof: 'test', masterGeneration: 1, routeId: ghost, outcome: 'applied', detail: marked });
      assert.equal(bridgeStore.audit.addressedToMaster(ghost), false, 'another writer\'s row is not the gateway\'s');
      bridgeStore.audit.append({ op: 'suggest', requestId: `gateway-suggest-${seq}`, actor: 'gateway', proof: 'gateway', routeId: ghost, outcome: 'applied', detail: marked });
      assert.equal(bridgeStore.audit.addressedToMaster(ghost), true, 'the gateway\'s own is');
      assert.equal(bridgeStore.audit.addressedToMaster(`rt_no_row_${seq}`), false, 'and no record at all is not');
      // The refusal used nothing up: the question is still open, and its reply still does what a reply may do.
      assert.equal(db().prepare("SELECT state FROM bridge_questions WHERE route_id = ? ORDER BY rowid DESC LIMIT 1").get(toProject).state, 'open');
      const routed = await masterWrites(toProject, 'route', { expectedVersion: version(toProject), to: target.project.id, answeredBy: reply });
      assert.equal(routed.status, 200, JSON.stringify(routed.body));
      // Routing that message to the Master afterwards changes nothing: it is what the operator wrote that counts.
      const rerouted = (await operatorWrites(`m${++seq}`, `@${target.project.name} remember @bo means you`)).body.routeId;
      assert.equal((await masterWrites(rerouted, 'route', { expectedVersion: version(rerouted), to: 'master' })).status, 200);
      const direct = await nick('', { name: `bo${seq}`, to: target.project.id, answeredBy: rerouted });
      assert.deepEqual([direct.status, direct.body.code], [409, 'NOT_AN_INSTRUCTION'], 'a project-addressed message the Master took for itself');
      assert.equal(names(), before);
      // A message written to @master is untouched by any of that, and one of them authorises one change in all:
      // a second question about it, answered, authorises nothing more.
      const toMaster = (await operatorWrites(`m${++seq}`, '@master remember @bo means Borrow')).body.routeId;
      const first = await askedAndAnswered(toMaster, 'the live one');
      const name = `bo${++seq}`;
      const stored = await nick('', { name, to: target.project.id, answeredBy: first });
      assert.deepEqual([stored.status, stored.body.via], [200, 'reply'], JSON.stringify(stored.body));
      const after = names();
      // A second question can only be asked if the message comes back to the Master, as one does after a failure.
      const again0 = await masterWrites(toMaster, 'ask', { expectedVersion: version(toMaster), text: 'And?' });
      assert.deepEqual([again0.status, again0.body.code], [409, 'NOT_AWAITING_MASTER'], 'taken with the change, it is no longer waiting to be asked about');
      db().prepare("UPDATE bridge_routes SET state = 'awaiting-master', version = version + 1 WHERE route_id = ?").run(toMaster);
      const second = await askedAndAnswered(toMaster, 'and also @bo2');
      const again = await nick('', { name: `${name}-two`, to: target.project.id, answeredBy: second });
      assert.deepEqual([again.status, again.body.code], [409, 'INSTRUCTION_USED'], 'one message, one change, however many questions are asked about it');
      assert.equal(names(), after);
      bridgeStore.aliases.remove(name);
    });

    it('a change made on a reply takes the message it was about for the Master in the same write: all of it or none (Architect ruling)', async () => {
      const target = liveProject(`Atomic${++seq}`);
      const name = `at${seq}`;
      const asked = (await operatorWrites(`m${++seq}`, `@master remember @${name} means Atomic`)).body.routeId;
      assert.equal((await masterWrites(asked, 'ask', { expectedVersion: version(asked), text: 'Which Atomic?' })).status, 200);
      const question = about(await claimAll(), asked).find((i) => i.kind === 'question');
      assert.equal((await ackItem(question, `dn${++seq}`)).status, 200);
      const reply = await operatorReplies(`dn${seq}`, 'the live one');
      const questionId = db().prepare('SELECT question_id FROM bridge_questions WHERE route_id = ?').get(asked).question_id;
      /** Everything the write could touch, as it stands. */
      const standing = () => JSON.stringify({
        names: bridgeStore.aliases.records(),
        instruction: db().prepare('SELECT state, version, destination_kind, resolved_by, resolved_generation FROM bridge_routes WHERE route_id = ?').get(asked),
        reply: db().prepare('SELECT state, version FROM bridge_routes WHERE route_id = ?').get(reply),
        question: db().prepare('SELECT state, adopted_route_id, adopted_for FROM bridge_questions WHERE question_id = ?').get(questionId),
        applied: db().prepare("SELECT COUNT(*) AS n FROM bridge_audit WHERE route_id IN (?, ?) AND outcome = 'applied' AND op IN ('route', 'nickname-set')").get(asked, reply).n
      });
      const before = standing();
      const startVersion = version(asked);

      // The message cannot be routed to the Master as it stands: refused, and nothing is used.
      db().prepare("UPDATE bridge_routes SET state = 'queued-master-unavailable' WHERE route_id = ?").run(asked);
      const held = await nick('', { name, to: target.project.id, answeredBy: reply });
      assert.deepEqual([held.status, held.body.code], [409, 'NOT_AWAITING_MASTER'], JSON.stringify(held.body));
      db().prepare("UPDATE bridge_routes SET state = 'awaiting-master' WHERE route_id = ?").run(asked);
      assert.equal(standing(), before, 'nothing moved');

      // A failure part way through leaves nothing behind: not the name, not the routing, not the settled question.
      const realSettle = bridgeStore.questions.settleOnReply;
      bridgeStore.questions.settleOnReply = () => { throw new Error('injected: the write fails after the change and the routing'); };
      try {
        assert.throws(() => bridgeStore.applyNicknameWrite({
          op: 'nickname-set', requestId: `req-inject-${++seq}-0000`, answeredBy: reply, proof: 'test', masterGeneration: 1,
          change: () => { bridgeStore.aliases.set(name, { kind: 'project', projectId: target.project.id }, { by: 'master', confirmedRouteId: reply }); return { detail: { nickname: name } }; }
        }), /injected/);
      } finally { bridgeStore.questions.settleOnReply = realSettle; }
      assert.equal(standing(), before, 'rolled back whole');
      assert.equal(db().prepare('SELECT COUNT(*) AS n FROM bridge_audit WHERE request_id = ?').get(`req-inject-${seq}-0000`).n, 0);

      // A change that is itself refused takes nothing for the Master either.
      const taken = `taken${++seq}`;
      bridgeStore.aliases.set(taken, { kind: 'project', projectId: target.project.id });
      const clash = await nick('', { name: taken, to: target.project.id, answeredBy: reply });
      assert.deepEqual([clash.status, clash.body.code], [409, 'NICKNAME_EXISTS']);
      bridgeStore.aliases.remove(taken);
      assert.equal(standing(), before);

      // It works: one write, and every part of it is there.
      // Anything still waiting on that message as a held one ends with it: here, a launch left queued for it.
      const consent = (await operatorWrites(`m${++seq}`, 'yes')).body.routeId;
      const now = new Date().toISOString();
      db().prepare("INSERT INTO bridge_questions (question_id, route_id, purpose, target_project_id, state, asked_generation, asked_at, expires_at, adopted_route_id, adopted_for, settled_at) VALUES (?, ?, 'launch', ?, 'adopted', 1, ?, ?, ?, 'launch', ?)")
        .run(`q_launch_${seq}`, asked, target.project.id, now, new Date(Date.now() + 3600000).toISOString(), consent, now);
      db().prepare("INSERT INTO bridge_launches (route_id, question_id, consent_route_id, project_id, master_generation, state, requested_at) VALUES (?, ?, ?, ?, 1, 'queued', ?)")
        .run(asked, `q_launch_${seq}`, consent, target.project.id, now);
      const requestId = `req-atomic-${++seq}-0000`;
      const write = () => call('POST', '/api/bridge/master/nicknames', { headers: asMaster(), body: { requestId, name, to: target.project.id, answeredBy: reply } });
      const stored = await write();
      assert.deepEqual([stored.status, stored.body.via, stored.body.instructionRouteId], [200, 'reply', asked], JSON.stringify(stored.body));
      const instruction = bridgeStore.routes.get(asked);
      assert.deepEqual([instruction.state, instruction.destination.kind, instruction.resolvedBy], ['routed', 'master', 'master'], 'no longer awaiting the Master');
      assert.ok(instruction.version > startVersion);
      assert.deepEqual(stored.body.instruction, { routeId: asked, state: 'routed', version: instruction.version });
      assert.equal(bridgeStore.aliases.record(name).confirmedRouteId, reply);
      assert.deepEqual({ ...db().prepare('SELECT state, adopted_route_id, adopted_for FROM bridge_questions WHERE question_id = ?').get(questionId) }, { state: 'adopted', adopted_route_id: reply, adopted_for: 'nickname' });
      assert.equal(bridgeStore.routes.get(reply).state, 'closed');
      // The Master's decision about that message is on that message's own record, by the Master, at the version it had.
      const decided = db().prepare("SELECT actor, expected_version, master_generation, detail_json FROM bridge_audit WHERE route_id = ? AND op = 'route' AND outcome = 'applied'").all(asked);
      assert.equal(decided.length, 1);
      assert.deepEqual([decided[0].actor, decided[0].expected_version, typeof decided[0].master_generation], ['master', startVersion, 'number']);
      assert.deepEqual(JSON.parse(decided[0].detail_json), { to: 'master', projectId: null, questionId, replyRouteId: reply, adoptedFor: 'nickname', with: 'nickname-set', launchesAbandoned: 1 });
      assert.equal(db().prepare("SELECT COUNT(*) AS n FROM bridge_launches WHERE route_id = ? AND settled_at IS NULL").get(asked).n, 0, 'nothing is launched for a message that is no longer held');
      // A write that was reading the old version is told it is stale.
      const stale = await masterWrites(asked, 'route', { expectedVersion: startVersion, to: target.project.id });
      assert.deepEqual([stale.status, stale.body.code], [409, 'VERSION_CONFLICT']);
      // The same request again is the same answer, and does nothing twice.
      const after = standing();
      const replay = await write();
      assert.deepEqual([replay.status, replay.body.replayed, replay.body.instruction], [200, true, stored.body.instruction]);
      assert.equal(standing(), after);
      // And the Master answers the instruction in the same conversation, with no route step of its own.
      assert.equal((await masterWrites(asked, 'answer', { expectedVersion: version(asked), text: `Stored: @${name} is ${target.project.name}.` })).status, 200);

      // The same holds for every kind of change, not only a new name: here a forget, then a rename.
      const heldAndAnswered = async (text) => {
        const routeId = (await operatorWrites(`m${++seq}`, text)).body.routeId;
        assert.equal((await masterWrites(routeId, 'ask', { expectedVersion: version(routeId), text: 'Which?' })).status, 200);
        assert.equal((await ackItem(about(await claimAll(), routeId).find((i) => i.kind === 'question'), `dn${++seq}`)).status, 200);
        return { routeId, reply: await operatorReplies(`dn${seq}`, 'that one') };
      };
      const renameIt = await heldAndAnswered('@master rename that one');
      // The store's write alone, before the gateway carries anything: the decision is whole and durable as it commits,
      // one version on from where the message stood.
      const stood = version(renameIt.routeId);
      const direct = bridgeStore.applyNicknameWrite({
        op: 'nickname-rename', requestId: `req-direct-${++seq}-0000`, answeredBy: renameIt.reply, proof: 'test', masterGeneration: 1,
        change: () => (bridgeStore.aliases.rename(name, `${name}-b`, { by: 'master', confirmedRouteId: renameIt.reply }) ? { detail: { nickname: `${name}-b`, was: name } } : { refuse: 'nickname-not-found' })
      });
      assert.deepEqual([direct.outcome, direct.detail.instructionRouteId], ['applied', renameIt.routeId]);
      const committed = db().prepare('SELECT state, version, destination_kind, resolved_by FROM bridge_routes WHERE route_id = ?').get(renameIt.routeId);
      assert.deepEqual({ ...committed }, { state: 'accepted', version: stood + 1, destination_kind: 'master', resolved_by: 'master' });
      // Had the first attempt stopped there, the retry with the same request id finishes the carrying and changes nothing else.
      const retried = await call('POST', `/api/bridge/master/nicknames/${name}/rename`, { headers: asMaster(), body: { requestId: `req-direct-${seq}-0000`, to: `${name}-b`, answeredBy: renameIt.reply } });
      assert.deepEqual([retried.status, retried.body.replayed, retried.body.instruction.state], [200, true, 'routed'], JSON.stringify(retried.body));
      assert.equal(bridgeStore.routes.get(renameIt.routeId).state, 'routed');
      assert.equal(db().prepare("SELECT COUNT(*) AS n FROM bridge_audit WHERE route_id = ? AND op = 'route' AND outcome = 'applied'").get(renameIt.routeId).n, 1);
      const forgetIt = await heldAndAnswered('@master forget that one');
      const forgot = await nick(`/${name}-b/forget`, { answeredBy: forgetIt.reply });
      assert.deepEqual([forgot.status, forgot.body.via, forgot.body.instruction.state], [200, 'reply', 'routed'], JSON.stringify(forgot.body));
      assert.equal(bridgeStore.routes.get(forgetIt.routeId).state, 'routed');
      assert.equal(JSON.parse(db().prepare("SELECT detail_json FROM bridge_audit WHERE route_id = ? AND op = 'route' AND outcome = 'applied'").get(forgetIt.routeId).detail_json).with, 'nickname-forget');
      assert.equal(bridgeStore.aliases.record(`${name}-b`), null);
    });

    it('when the message does not say exactly one thing, the Master asks, and the operator\'s reply is what authorises it', async () => {
      const one = liveProject(`Alpha_One_${++seq}`);
      liveProject(`Alpha_Two_${++seq}`);
      const al = `al${seq}`;
      // "@master remember @al means Alpha": which Alpha? The Master asks before it has taken the message.
      const asked = (await operatorWrites(`m${++seq}`, `@master remember @${al} means Alpha`)).body.routeId;
      assert.equal((await masterWrites(asked, 'ask', { expectedVersion: version(asked), text: `Which did you mean: ${one.project.name}, or the other?` })).status, 200);
      const question = about(await claimAll(), asked).find((i) => i.kind === 'question');
      assert.equal((await ackItem(question, `dn${++seq}`)).status, 200);
      const reply = await operatorReplies(`dn${seq}`, 'the first');
      const stored = await nick('', { name: al, to: one.project.id, answeredBy: reply });
      assert.deepEqual([stored.status, stored.body.via, typeof stored.body.questionId], [200, 'reply', 'string'], JSON.stringify(stored.body));
      assert.equal(bridgeStore.aliases.record(al).confirmedRouteId, reply, 'the reply is the message on record behind it');
      const q = db().prepare('SELECT state, adopted_route_id, adopted_for FROM bridge_questions WHERE question_id = ?').get(stored.body.questionId);
      assert.deepEqual({ ...q }, { state: 'adopted', adopted_route_id: reply, adopted_for: 'nickname' });
      assert.equal(bridgeStore.routes.get(reply).state, 'closed', 'and its route is closed with the write');
      // The reply is used: it authorises nothing more, and routes nothing.
      const twice = await nick('', { name: `${al}-again`, to: one.project.id, answeredBy: reply });
      assert.deepEqual([twice.status, twice.body.code], [409, 'QUESTION_SETTLED']);
      // The write itself took the instruction for the Master: there is no later route step, and it is answered in the same conversation.
      const taken = bridgeStore.routes.get(asked);
      assert.deepEqual([taken.state, taken.destination.kind, taken.resolvedBy], ['routed', 'master', 'master']);
      assert.deepEqual(stored.body.instruction, { routeId: asked, state: 'routed', version: taken.version });
      const asRoute = await masterWrites(asked, 'route', { expectedVersion: version(asked), to: one.project.id, answeredBy: reply });
      assert.deepEqual([asRoute.status, asRoute.body.code], [409, 'NOT_AWAITING_MASTER'], 'and it cannot be routed anywhere else afterwards');
      // One operator request, one change: the instruction whose question was answered is used up with the reply.
      const before = names();
      const second = await nick('', { name: `${al}-second`, to: one.project.id, answeredBy: asked });
      assert.deepEqual([second.status, second.body.code], [409, 'INSTRUCTION_USED'], 'the instruction does not authorise a second change after its reply authorised the first');
      assert.equal(names(), before);
      assert.equal((await masterWrites(asked, 'answer', { expectedVersion: version(asked), text: `Stored: @${al} is ${one.project.name}.` })).status, 200);
    });

    it('a nickname never makes a name mean two things, and a refused change uses nothing up', async () => {
      const target = liveProject(`Clash_Target_${++seq}`);
      const other = liveProject(`Clash_Other_${++seq}`);
      const [taken, fine, boss] = [`taken${seq}`, `fine${seq}`, `boss${seq}`];
      const asked = await instruction('@master remember some names');
      bridgeStore.aliases.set(taken, { kind: 'project', projectId: other.project.id });
      const before = names();
      const CASES = [
        ['master', 'NICKNAME_RESERVED'], ['@MASTER', 'NICKNAME_RESERVED'],
        // The words `tc bridge nickname` reads as what to do, and any number: a number is a project's id, whoever has it.
        ['set', 'NICKNAME_RESERVED'], ['Rename', 'NICKNAME_RESERVED'], ['forget', 'NICKNAME_RESERVED'],
        ['987654321', 'NICKNAME_COLLIDES'], ['57', 'NICKNAME_COLLIDES'],
        [taken, 'NICKNAME_EXISTS'],
        [other.project.name, 'NICKNAME_COLLIDES'], [other.project.name.toUpperCase(), 'NICKNAME_COLLIDES'],
        [bridgeReach.slugOf(other.project.name), 'NICKNAME_COLLIDES'], [String(other.project.id), 'NICKNAME_COLLIDES']
      ];
      for (const [name, code] of CASES) {
        const res = await nick('', { name, to: target.project.id, answeredBy: asked });
        assert.deepEqual([res.status, res.body.code], [409, code], name);
      }
      for (const name of [undefined, '', '@', 'has space', '-leading', 'a/b', 'x'.repeat(65), 42]) {
        const res = await nick('', { name, to: target.project.id, answeredBy: asked });
        assert.deepEqual([res.status, res.body.code], [400, 'BAD_NICKNAME'], JSON.stringify(name));
      }
      for (const [to, status, code] of [['No Such Project', 400, 'UNKNOWN_DESTINATION'], [undefined, 400, 'UNKNOWN_DESTINATION']]) {
        const res = await nick('', { name: fine, to, answeredBy: asked });
        assert.deepEqual([res.status, res.body.code], [status, code], JSON.stringify(to));
      }
      assert.equal((await asOperator('POST', '/api/bridge/operator/optouts', { body: { project: target.project.id } })).status, 200);
      const out = await nick('', { name: fine, to: target.project.id, answeredBy: asked });
      assert.deepEqual([out.status, out.body.code], [409, 'DESTINATION_OPTED_OUT'], 'a nickname is not given to a project out of reach');
      const outByName = await nick('', { name: fine, to: target.project.name, answeredBy: asked });
      assert.deepEqual([outByName.status, outByName.body.code], [409, 'DESTINATION_OPTED_OUT'], 'however the project is named');
      assert.match(outByName.body.error, /^The nickname was not changed\. .*out of reach of the bridge by the operator's choice/, 'and the refusal says why, as any other write to that project is told');
      // A scope that cannot be resolved is refused with what is wrong with it, not with one fixed reason.
      const scopeWas = bridgeReach._deps.masterScope;
      bridgeReach._deps.masterScope = () => ({ type: 'not-a-scope' });
      try {
        const noScope = await nick('', { name: fine, to: other.project.id, answeredBy: asked });
        assert.deepEqual([noScope.status, noScope.body.code], [409, 'SCOPE_UNRESOLVED']);
        assert.match(noScope.body.error, /^The nickname was not changed\. The Project Master's scope cannot be resolved \(it is not a scope the bridge understands\)/);
      } finally { bridgeReach._deps.masterScope = scopeWas; }
      // Every one of those refusals is on the audit, against the message, with the nickname it was about and none of the message's words.
      const refusals = db().prepare("SELECT outcome, detail_json FROM bridge_audit WHERE op = 'nickname-set' AND route_id = ? AND outcome <> 'applied' ORDER BY audit_seq").all(asked);
      assert.deepEqual([...new Set(refusals.map((r) => r.outcome))].sort(), ['destination-opted-out', 'nickname-collides', 'nickname-exists', 'nickname-reserved', 'scope-unresolved', 'unknown-destination']);
      assert.ok(refusals.every((r) => typeof JSON.parse(r.detail_json).nickname === 'string'), 'each names the nickname');
      assert.equal(JSON.parse(refusals.at(-1).detail_json).nickname, fine);
      // The operator's own route holds a new name to the same rule, under its own codes for what it always refused.
      for (const [alias, code] of [['set', 'ALIAS_RESERVED'], ['Forget', 'ALIAS_RESERVED'], ['4242', 'NICKNAME_COLLIDES'], [other.project.name, 'NICKNAME_COLLIDES'], ['has space', 'BAD_ALIAS']]) {
        const res = await asOperator('POST', '/api/bridge/operator/aliases', { body: { alias, to: other.project.id } });
        assert.equal(res.body.code, code, alias);
      }
      // A nickname whose project is out of reach is refused as a destination for the reason it is out of reach, not as an unknown name.
      const viaNickname = (await operatorWrites(`m${++seq}`, '@nobody-known hello')).body.routeId;
      bridgeStore.aliases.set(`stale-${fine}`, { kind: 'project', projectId: target.project.id });
      const routedByName = await masterWrites(viaNickname, 'route', { expectedVersion: version(viaNickname), to: `stale-${fine}` });
      assert.deepEqual([routedByName.status, routedByName.body.code], [409, 'DESTINATION_OPTED_OUT']);
      bridgeStore.aliases.remove(`stale-${fine}`);
      assert.equal((await asOperator('DELETE', '/api/bridge/operator/optouts/:projectId', { params: { projectId: String(target.project.id) } })).status, 200);
      assert.equal(names(), before, 'none of that stored anything');
      // And none of it used the operator's message up: the corrected change still goes through on it.
      const good = await nick('', { name: fine, to: target.project.id, answeredBy: asked });
      assert.deepEqual([good.status, good.body.nickname], [200, fine], JSON.stringify(good.body));
      // A nickname may point at the Master itself.
      const forMaster = await instruction('@master call yourself @boss');
      assert.equal((await nick('', { name: boss, to: 'master', answeredBy: forMaster })).status, 200);
      assert.deepEqual(suggestion((await operatorWrites(`m${++seq}`, `@${boss} hello`)).body.routeId), { by: 'alias', to: 'master', projectId: null, reason: null });
    });

    it('rename and forget, each on the operator\'s say-so; a nickname whose project is gone names nothing and says why', async () => {
      const target = liveProject(`Life${++seq}`);
      const [first, second] = [`first${seq}`, `second${seq}`];
      const set = await instruction('@master remember @first means it');
      assert.equal((await nick('', { name: first, to: target.project.id, answeredBy: set })).status, 200);
      const created = bridgeStore.aliases.record(first);

      const rename = await instruction(`@master rename @${first} to @${second}`);
      const missing = await nick(`/nope-${first}/rename`, { to: second, answeredBy: rename });
      assert.deepEqual([missing.status, missing.body.code], [404, 'NICKNAME_NOT_FOUND']);
      const clash = await nick(`/${first}/rename`, { to: target.project.name, answeredBy: rename });
      assert.deepEqual([clash.status, clash.body.code], [409, 'NICKNAME_COLLIDES']);
      const renamed = await nick(`/${first}/rename`, { to: `@${second.charAt(0).toUpperCase()}${second.slice(1)}`, answeredBy: rename });
      assert.deepEqual([renamed.status, renamed.body.nickname, renamed.body.was], [200, second, first], JSON.stringify(renamed.body));
      assert.equal(bridgeStore.aliases.record(first), null);
      const after = bridgeStore.aliases.record(second);
      assert.deepEqual([after.destination, after.display, after.confirmedRouteId, after.createdAt, after.createdBy],
        [created.destination, `${second.charAt(0).toUpperCase()}${second.slice(1)}`, rename, created.createdAt, 'master'], 'what it points at, and who first made it, are unchanged');
      // To its own name in another case is a rename of how it is shown, not a clash with itself.
      const recase = await instruction(`@master show it as @${second.toUpperCase()}`);
      assert.equal((await nick(`/${second}/rename`, { to: second.toUpperCase(), answeredBy: recase })).status, 200);
      assert.equal(bridgeStore.aliases.record(second).display, second.toUpperCase());

      // The project goes out of reach: the nickname stays on record, names nothing, and is explained as that.
      store.projects.archive(target.project.id);
      const stale = (await call('GET', `/api/bridge/master/nicknames/${second}`, { headers: asMaster() })).body.nickname;
      assert.deepEqual([stale.reachable, stale.outOfReach, stale.live], [false, 'archived', null]);
      assert.equal(suggestion((await operatorWrites(`m${++seq}`, `@${second} hello?`)).body.routeId).reason, 'address-out-of-reach');
      const shown = await tc(['bridge', 'nickname', second]);
      assert.match(shown.stdout, /OUT OF REACH \(archived\): it names nothing until that changes/);

      const forget = await instruction(`@master forget @${second}`);
      const forgotten = await nick(`/${second}/forget`, { answeredBy: forget });
      assert.deepEqual([forgotten.status, forgotten.body.was], [200, second]);
      assert.equal(bridgeStore.aliases.record(second), null);
      const again = await instruction('@master forget it again');
      const gone = await nick(`/${second}/forget`, { answeredBy: again });
      assert.deepEqual([gone.status, gone.body.code], [404, 'NICKNAME_NOT_FOUND']);
      const trail = db().prepare("SELECT op, detail_json FROM bridge_audit WHERE op LIKE 'nickname-%' AND outcome = 'applied' AND route_id IN (?, ?, ?, ?) ORDER BY audit_seq").all(set, rename, recase, forget);
      assert.deepEqual(trail.map((r) => r.op), ['nickname-set', 'nickname-rename', 'nickname-rename', 'nickname-forget'], 'each change is on the audit, against the message that asked for it');
      assert.deepEqual(trail.map((r) => JSON.parse(r.detail_json)).map((d) => [d.nickname || null, d.was || null, d.to, d.projectId]),
        [[first, null, 'project', target.project.id], [second, first, 'project', target.project.id], [second, second, 'project', target.project.id], [null, second, 'project', target.project.id]],
        'each says the name before and after and what it pointed at');
      const refusedRows = db().prepare("SELECT outcome, detail_json FROM bridge_audit WHERE op LIKE 'nickname-%' AND outcome <> 'applied' AND route_id IN (?, ?) ORDER BY audit_seq").all(rename, again);
      assert.deepEqual(refusedRows.map((r) => [r.outcome, JSON.parse(r.detail_json).was]), [['nickname-not-found', `nope-${first}`], ['nickname-collides', first], ['nickname-not-found', second]]);
    });

    it('the same over the command line, and the operator can see and put right what was stored', async () => {
      const target = liveProject(`Cli_Nick_${++seq}`);
      const name = `cli${seq}`;
      const asked = await instruction(`@master remember @${name} means ${target.project.name}`);
      const bare = await tc(['bridge', 'nickname', 'set', name, '--to', String(target.project.id)]);
      assert.deepEqual([bare.code, /needs --answered-by <route-id>: the operator's message that asked for it/.test(bare.stderr)], [1, true]);
      const noTo = await tc(['bridge', 'nickname', 'set', name, '--answered-by', asked]);
      assert.deepEqual([noTo.code, /needs --to <master\|project>/.test(noTo.stderr)], [1, true]);
      const stored = await tc(['bridge', 'nickname', 'set', `@${name.toUpperCase()}`, '--to', bridgeReach.slugOf(target.project.name), '--answered-by', asked]);
      assert.equal(stored.code, 0, stored.stderr);
      assert.equal(stored.stdout, `Stored: @${name} now means project #${target.project.id}. Tell the operator in the same conversation with tc bridge answer.\n`);
      // On a reply, the command says which message is now the Master's to answer, so that it is not routed again.
      const unclear = (await operatorWrites(`m${++seq}`, '@master remember @that means Cli')).body.routeId;
      assert.equal((await masterWrites(unclear, 'ask', { expectedVersion: version(unclear), text: 'Which, and called what?' })).status, 200);
      assert.equal((await ackItem(about(await claimAll(), unclear).find((i) => i.kind === 'question'), `dn${++seq}`)).status, 200);
      const clarified = await operatorReplies(`dn${seq}`, 'this one');
      const viaReply = await tc(['bridge', 'nickname', 'set', `${name}-r`, '--to', String(target.project.id), '--answered-by', clarified]);
      assert.equal(viaReply.code, 0, viaReply.stderr);
      assert.equal(viaReply.stdout, `Stored: @${name}-r now means project #${target.project.id}. Their first message, ${unclear}, is now yours (version ${version(unclear)}): do not route it, answer it. Tell the operator in the same conversation with tc bridge answer.\n`);
      assert.equal(bridgeStore.routes.get(unclear).state, 'routed');
      bridgeStore.aliases.remove(`${name}-r`);
      const listed = await tc(['bridge', 'nicknames']);
      assert.ok(listed.stdout.includes(`  @${name.toUpperCase()} means project #${target.project.id} ${target.project.name}, running\n      set by you (an earlier or the present Master), on the operator's message ${asked}, `), listed.stdout);
      assert.match(listed.stdout, /A nickname is only ever a suggestion: nothing is sent until you route it\.\n$/);
      const refused = await tc(['bridge', 'nickname', 'forget', name, '--answered-by', asked]);
      assert.deepEqual([refused.code, /refused \[INSTRUCTION_USED\]/.test(refused.stderr)], [2, true]);
      const renameMsg = await instruction(`@master rename @${name} to @${name}b`);
      const renamed = await tc(['bridge', 'nickname', 'rename', name, `${name}b`, '--answered-by', renameMsg]);
      assert.equal(renamed.stdout, `Renamed: @${name} is now @${name}b. Tell the operator in the same conversation with tc bridge answer.\n`);
      const extra = await tc(['bridge', 'nickname', 'rename', name, `${name}c`, '--to', 'master', '--answered-by', renameMsg]);
      assert.deepEqual([extra.code, /takes no --to/.test(extra.stderr)], [1, true]);
      const odd = await tc(['bridge', 'nickname', 'has/slash']);
      assert.deepEqual([odd.code, /is not shaped like a nickname/.test(odd.stderr)], [1, true], 'a name is never put in a path as typed');

      // The operator sees who stored it, when and on which message, and can remove it: the dashboard is for looking and putting right.
      const status = (await asOperator('GET', '/api/bridge/operator/status')).body;
      const seen = status.nicknames.find((n) => n.nickname === `${name}b`);
      assert.deepEqual([seen.changedBy, seen.confirmedRouteId, seen.destination.name, seen.reachable], ['master', renameMsg, target.project.name, true]);
      // The operator's own nickname is recorded as theirs, and re-pointing one that exists is theirs to do.
      const op = `op${seq}`;
      assert.equal((await asOperator('POST', '/api/bridge/operator/aliases', { body: { alias: `Op${seq}`, to: target.project.id } })).status, 200);
      const mine = bridgeStore.aliases.record(op);
      assert.deepEqual([mine.createdBy, mine.changedBy, mine.confirmedRouteId, mine.display], ['operator', 'operator', null, `O${op.slice(1)}`]);
      // Written with its @ or without, it is the same nickname: one reading for the operator's route and the Master's.
      assert.equal((await asOperator('POST', '/api/bridge/operator/aliases', { body: { alias: `@${op}`, to: 'master' } })).status, 200);
      assert.deepEqual(bridgeStore.aliases.record(op).destination, { kind: 'master', projectId: null });
      assert.equal(bridgeStore.aliases.record(`@${op}`), null, 'no second nickname with the @ in its name');
      // Pointing a nickname somewhere else keeps who first made it and when; only who changed it last moves.
      bridgeStore.aliases.set(`old-${op}`, { kind: 'master', projectId: null }, { by: 'master', confirmedRouteId: asked, display: `old-${op}`, at: '2026-01-01T00:00:00.000Z' });
      assert.equal((await asOperator('POST', '/api/bridge/operator/aliases', { body: { alias: `old-${op}`, to: target.project.id } })).status, 200);
      const moved = bridgeStore.aliases.record(`old-${op}`);
      assert.deepEqual([moved.createdBy, moved.createdAt, moved.changedBy, moved.confirmedRouteId, moved.destination.projectId], ['master', '2026-01-01T00:00:00.000Z', 'operator', null, target.project.id]);
      assert.notEqual(moved.changedAt, '2026-01-01T00:00:00.000Z');
      assert.equal((await asOperator('DELETE', '/api/bridge/operator/aliases/:alias', { params: { alias: `${name}b` } })).status, 200);
      assert.equal(bridgeStore.aliases.record(`${name}b`), null);
      const forgetMsg = await instruction('@master forget it');
      const forgot = await tc(['bridge', 'nickname', 'forget', op, '--answered-by', forgetMsg]);
      assert.equal(forgot.stdout, `Forgotten: @${op} no longer means anything. Tell the operator in the same conversation with tc bridge answer.\n`);
    });
  });

  describe('how the helper\'s Discord connection reads (#2272)', () => {
    const NEVER = { reading: 'never-reported', state: null, since: null, fatalCloseCode: null, reportedAt: null };

    // Whatever the cases above left waiting is leased here, so each case below
    // is handed only what it queued itself. Nothing in this block moves the
    // clock forward, so those leases stay live throughout.
    beforeEach(async () => {
      while ((await claim()).body.items.length > 0) { /* until nothing is left to lease */ }
    });

    /**
     * Claim as the helper does, with a body of the test's choosing.
     * @param {object} body - The claim's body.
     * @returns {Promise<{status: number, body: object}>}
     */
    const claimWith = (body) => call('POST', '/api/bridge/helper/outbound/claim', { headers: asHelper(), body });

    /**
     * The reading as each of its two readers is given it.
     * @returns {Promise<object[]>} The operator's, then the Master's.
     */
    const readings = async () => [
      (await asOperator('GET', '/api/bridge/operator/status')).body.discordGateway,
      (await call('GET', '/api/bridge/master/status', { headers: asMaster() })).body.discordGateway
    ];

    /**
     * Run with the gateway's clock held at one time.
     * @param {string} when - ISO time.
     * @param {function(): Promise<*>} fn - What to run.
     * @returns {Promise<*>}
     */
    const at = async (when, fn) => {
      const realNow = gateway._deps.now;
      gateway._deps.now = () => when;
      try { return await fn(); } finally { gateway._deps.now = realNow; }
    };

    /**
     * The `Discord connection` line of `tc bridge status`.
     * @returns {Promise<string>}
     */
    const tcLine = async () => {
      const shown = await tc(['bridge', 'status']);
      assert.equal(shown.code, 0, shown.stderr);
      const lines = shown.stdout.split('\n').filter((line) => line.startsWith('Discord connection: '));
      assert.equal(lines.length, 1, shown.stdout);
      assert.ok(shown.stdout.startsWith('Operator bridge: enabled; '), 'the line it already printed still comes first');
      return lines[0];
    };

    it('says never reported until the helper reports, and a claim with no report is answered as it always was', async () => {
      assert.deepEqual(await readings(), [NEVER, NEVER]);
      assert.equal(await tcLine(), 'Discord connection: never reported since this server started: the helper is not running, has not yet asked for work, or predates the report and needs a restart.');

      // A helper not yet restarted sends no report. It keeps working, and reads as not reported.
      for (const body of [{}, { limit: 20 }]) {
        const old = await claimWith(body);
        assert.deepEqual([old.status, old.body], [200, { replayed: false, items: [] }]);
      }
      assert.deepEqual(await readings(), [NEVER, NEVER]);

      // Disabled, the bridge refuses the claim before it reads the report: the line must not blame the helper for that.
      assert.equal((await asOperator('POST', '/api/bridge/operator/disable')).status, 200);
      const refused = await claimWith({ discordGateway: { state: 'ready', since: '2026-10-11T05:00:02.000Z' } });
      assert.deepEqual([refused.status, refused.body.code], [409, 'BRIDGE_DISABLED']);
      assert.deepEqual(await readings(), [NEVER, NEVER]);
      const off = (await tc(['bridge', 'status'])).stdout.split('\n').find((line) => line.startsWith('Discord connection: '));
      assert.equal(off, 'Discord connection: never reported since this server started: the helper is not running, has not yet asked for work, or predates the report and needs a restart.'
        + ' The bridge is disabled, and a disabled bridge does not read the helper\'s reports: this says nothing about the helper.');
    });

    it('a claim carrying a report is answered exactly as one without, and both readers are then told what was reported and since when', async () => {
      const accepted = await operatorSays(`m${++seq}`, '@master hello');
      await masterWrites(accepted.body.routeId, 'answer', { expectedVersion: bridgeStore.routes.get(accepted.body.routeId).version, text: 'hi' });

      const ready = { state: 'ready', since: '2026-10-11T05:00:02.000Z', fatalCloseCode: null };
      const answer = await at('2026-10-11T05:00:10.000Z', () => claimWith({ limit: 20, discordGateway: ready }));
      assert.deepEqual([answer.status, Object.keys(answer.body), answer.body.replayed], [200, ['replayed', 'items'], false], 'nothing is added to the answer');
      assert.deepEqual(answer.body.items.map((item) => [item.text, item.leaseState]), [['hi', 'live']], 'and what waited is handed over under a lease, as before');

      await at('2026-10-11T05:00:20.000Z', async () => {
        const connected = { reading: 'connected', ...ready, reportedAt: '2026-10-11T05:00:10.000Z' };
        assert.deepEqual(await readings(), [connected, connected]);
        assert.equal(await tcLine(), 'Discord connection: connected since 2026-10-11T05:00:02.000Z (the helper\'s report of 2026-10-11T05:00:10.000Z).');
      });

      // Down, and trying: counted from when it stopped being ready, which is the time the helper sends.
      await at('2026-10-11T05:09:00.000Z', async () => {
        assert.equal((await claimWith({ discordGateway: { state: 'reconnecting', since: '2026-10-11T05:03:00.000Z' } })).status, 200, 'a close code left out is one that is null');
        const down = { reading: 'down', state: 'reconnecting', since: '2026-10-11T05:03:00.000Z', fatalCloseCode: null, reportedAt: '2026-10-11T05:09:00.000Z' };
        assert.deepEqual(await readings(), [down, down]);
        assert.equal(await tcLine(), 'Discord connection: NOT CONNECTED since 2026-10-11T05:03:00.000Z: the helper reports reconnecting (its report of 2026-10-11T05:09:00.000Z). Nothing the operator writes arrives meanwhile.');

        // Refused by Discord: not retrying, and the line must not read like a connection that is.
        assert.equal((await claimWith({ discordGateway: { state: 'fatal', since: '2026-10-11T05:03:00.000Z', fatalCloseCode: 4014 } })).status, 200);
        assert.deepEqual((await readings())[1], { ...down, state: 'fatal', fatalCloseCode: 4014 });
        assert.equal(await tcLine(), 'Discord connection: NOT CONNECTED since 2026-10-11T05:03:00.000Z: the helper reports fatal (close code 4014): '
          + 'Discord refused the connection and the helper will not retry until it is put right and restarted (its report of 2026-10-11T05:09:00.000Z). Nothing the operator writes arrives meanwhile.');

        // A report still current when the bridge is switched off is still what the helper said: nothing is added to it.
        const fatalLine = await tcLine();
        assert.equal((await asOperator('POST', '/api/bridge/operator/disable')).status, 200);
        assert.equal((await tc(['bridge', 'status'])).stdout.split('\n').find((line) => line.startsWith('Discord connection: ')), fatalLine);
      });
    });

    it('a report that is not one refuses the whole claim: nothing is leased, and the last good report stays', async () => {
      const good = { state: 'ready', since: '2026-10-11T05:00:02.000Z', fatalCloseCode: null };
      await at('2026-10-11T05:00:10.000Z', () => claimWith({ discordGateway: good }));
      const before = { reading: 'connected', ...good, reportedAt: '2026-10-11T05:00:10.000Z' };
      const text = 'waits through every refused claim';
      const id = bridgeStore.outbound.enqueue({
        idemKey: `notify:operator-needed:report-${++seq}`, kind: 'notification', notifyType: 'operator-needed', sourceLabel: 'TangleClaw', text, digest: bridgeStore.digest(text)
      }).outboundId;

      const malformed = {
        'a state the helper does not have': { ...good, state: 'online' },
        'no state': { since: good.since },
        'words where the time belongs': { ...good, since: 'five minutes ago' },
        'a time not written as the helper writes one': { ...good, since: '2026-10-11T05:00:02Z' },
        'a date that does not exist': { ...good, since: '2026-02-30T05:00:02.000Z' },
        'a number where the time belongs': { ...good, since: 1791522002000 },
        'no time': { state: 'ready' },
        'a field nobody defined': { ...good, detail: 'socket hang up' },
        'a close code on a connection that was not refused': { ...good, fatalCloseCode: 4004 },
        'a refusal with no close code': { state: 'fatal', since: good.since },
        'a close code that is text': { state: 'fatal', since: good.since, fatalCloseCode: '4004' },
        'a close code no socket can close with': { state: 'fatal', since: good.since, fatalCloseCode: 999 },
        'a close code past the range': { state: 'fatal', since: good.since, fatalCloseCode: 5000 },
        'a close code that is not whole': { state: 'fatal', since: good.since, fatalCloseCode: 4004.5 },
        'a list': [good],
        'a word': 'ready',
        'nothing, said outright': null
      };
      const logged = [];
      setLevel('warn');
      setConsoleStream({ write: (line) => { logged.push(String(line)); return true; } });
      try {
        await at('2026-10-11T05:00:30.000Z', async () => {
          for (const [what, discordGateway] of Object.entries(malformed)) {
            const refused = await claimWith({ limit: 20, discordGateway });
            assert.deepEqual([refused.status, refused.body.code, Object.keys(refused.body).sort()], [400, 'BAD_GATEWAY_REPORT', ['code', 'error']], what);
            assert.deepEqual(await readings(), [before, before], what);
          }
        });
      } finally {
        setConsoleStream(null);
        setLevel('error');
      }
      // Each refusal leaves a line in the server's log: the helper's own log says only that a claim failed with 400.
      const refusals = logged.filter((line) => line.includes('Bridge request refused') && line.includes('BAD_GATEWAY_REPORT'));
      assert.equal(refusals.length, Object.keys(malformed).length, logged.join(''));
      for (const line of refusals) assert.ok(!line.includes('socket hang up') && !line.includes('five minutes ago'), 'the code, and nothing of what was sent');
      await at('2026-10-11T05:00:30.000Z', async () => {
        // A claim that is itself malformed records nothing either, however good the report in it.
        const badLimit = await claimWith({ limit: 500, discordGateway: { ...good, since: '2026-10-11T05:00:25.000Z' } });
        assert.deepEqual([badLimit.status, badLimit.body.code], [400, 'BAD_CLAIM']);
        assert.deepEqual(await readings(), [before, before]);
      });
      assert.equal(bridgeStore.outbound.get(id).attempts, 0, 'none of those claims was handed the item');
      const handed = (await claimWith({ limit: 20, discordGateway: good })).body.items.find((item) => item.outboundId === id);
      assert.deepEqual([handed.leaseState, handed.attempts], ['live', 1], 'the first good claim is the first to be handed it');
    });

    it('a report older than three minutes reads as not reported, whatever it said', async () => {
      assert.equal(gateway.DISCORD_REPORT_STALE_MS, 3 * 60 * 1000);
      for (const report of [
        { state: 'ready', since: '2026-10-11T05:00:02.000Z', fatalCloseCode: null },
        { state: 'connecting', since: '2026-10-11T04:50:00.000Z', fatalCloseCode: null }
      ]) {
        await at('2026-10-11T05:00:10.000Z', () => claimWith({ discordGateway: report }));
        const fresh = report.state === 'ready' ? 'connected' : 'down';
        await at('2026-10-11T05:03:10.000Z', async () => {
          assert.deepEqual((await readings()).map((r) => r.reading), [fresh, fresh], 'three minutes exactly is still a report of now');
        });
        await at('2026-10-11T05:03:10.001Z', async () => {
          const stale = { reading: 'not-reported', ...report, reportedAt: '2026-10-11T05:00:10.000Z' };
          assert.deepEqual(await readings(), [stale, stale]);
          assert.equal(await tcLine(), `Discord connection: NOT REPORTED since 2026-10-11T05:00:10.000Z: the helper last said ${report.state} and has not reported since. `
            + 'It may not be running; whether Discord is connected is not known.');
        });
        // The next report is of now again.
        await at('2026-10-11T05:10:00.000Z', async () => {
          await claimWith({ discordGateway: report });
          assert.deepEqual((await readings()).map((r) => [r.reading, r.reportedAt]), [[fresh, '2026-10-11T05:10:00.000Z'], [fresh, '2026-10-11T05:10:00.000Z']]);
        });
      }
    });

    it('a claim the bridge will not hand anything over on still says the helper is there', async () => {
      const text = 'notice for a closed chat';
      const id = bridgeStore.outbound.enqueue({
        idemKey: `notify:operator-needed:report-circuit-${++seq}`, kind: 'notification', notifyType: 'operator-needed', sourceLabel: 'TangleClaw', text, digest: bridgeStore.digest(text)
      }).outboundId;
      const item = (await claim()).body.items.find((i) => i.outboundId === id);
      await call('POST', `/api/bridge/helper/outbound/${id}/failure`, { headers: asHelper(), body: { leaseId: item.leaseId, reason: 'chat-channel-missing' } });

      const report = { state: 'ready', since: '2026-10-11T05:00:02.000Z', fatalCloseCode: null };
      const blocked = await at('2026-10-11T05:00:10.000Z', () => claimWith({ discordGateway: report }));
      assert.deepEqual([blocked.status, blocked.body.code], [409, 'BRIDGE_CONFIGURATION_BLOCKED']);
      await at('2026-10-11T05:00:11.000Z', async () => {
        assert.deepEqual((await readings())[0], { reading: 'connected', ...report, reportedAt: '2026-10-11T05:00:10.000Z' });
      });
      // The circuit is closed again, and its item withdrawn, so the cases after this one find the bridge as they expect it.
      const reset = await call('POST', '/api/bridge/master/circuit/reset', { headers: asMaster(), body: { requestId: `req-r-${++seq}-0000`, decision: 'withdraw' } });
      assert.equal(reset.status, 200, JSON.stringify(reset.body));
      assert.equal(bridgeStore.circuit.open(), null);
    });

    it('tc bridge status says nothing of the connection to a server that does not report it, or reports a reading it does not know', async () => {
      const http = require('node:http');
      const base = { enabled: true, openRoutes: 0, masterGeneration: 1, proof: 'master-launch', configurationCircuit: null, scope: { kind: 'all' } };
      for (const [what, body] of Object.entries({
        'a server from before the report': base,
        'a reading from after this tc': { ...base, discordGateway: { reading: 'degraded', state: 'ready', since: null, fatalCloseCode: null, reportedAt: null } }
      })) {
        const old = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); });
        await new Promise((resolve) => old.listen(0, '127.0.0.1', resolve));
        try {
          const shown = await tc(['bridge', 'status'], { TANGLECLAW_API: `http://127.0.0.1:${old.address().port}` });
          assert.equal(shown.stdout, 'Operator bridge: enabled; 0 open route(s). You are Master generation 1 (master-launch).\n', what);
        } finally {
          await new Promise((resolve) => old.close(resolve));
        }
      }
    });

    it('every state the helper\'s own gateway can be in is a report the bridge admits', async () => {
      const { createGateway, OP } = require('../lib/bridge-helper/discord-gateway');
      const { gatewayReport } = require('../lib/bridge-helper/outbound');
      const { fakeWebSocket } = require('./_fake-discord');
      const ws = fakeWebSocket();
      const idle = { setTimeout: () => 1, clearTimeout: () => {}, setInterval: () => 1, clearInterval: () => {} };
      const gw = createGateway({ token: 'not-a-token', WebSocket: ws.WebSocket, timers: idle, log: () => {}, onMessageCreate: () => {} });
      const seen = [];
      /** @returns {void} */
      const admit = () => {
        const report = gatewayReport(gw.status());
        assert.deepEqual(gateway.discordReport(JSON.parse(JSON.stringify(report))), report, report.state);
        seen.push(report.state);
      };
      admit();
      gw.start();
      admit();
      ws.sockets[0].receive({ op: OP.HELLO, d: { heartbeat_interval: 40000 } });
      ws.sockets[0].receive({ op: OP.DISPATCH, t: 'READY', s: 1, d: { session_id: 'sess-1', user: { id: '900000000000000009' } } });
      admit();
      ws.sockets[0].drop(1006);
      admit();
      gw.stop();
      admit();
      gw.start();
      ws.sockets[1].drop(4004);
      admit();
      assert.deepEqual([...seen].sort(), [...gateway.DISCORD_STATES].sort(), 'and those are all the states there are');
    });
  });

  describe('who may call what', () => {
    it('the helper routes answer only the active helper token, with a fresh nonce on every write', async () => {
      const body = { externalId: `m${++seq}`, ...ALLOWED, text: 'hello' };
      for (const headers of [{}, asHelper({ [bridgeApi.HELPER_TOKEN_HEADER]: 'bht_wrong' }), asMaster(), operatorHeaders(server)]) {
        const r = await call('POST', '/api/bridge/helper/inbound', { headers, body });
        assert.deepEqual([r.status, r.body.code], [401, 'HELPER_TOKEN_REQUIRED']);
        assert.equal((await claim(headers)).status, 401);
      }
      const noNonce = await call('POST', '/api/bridge/helper/inbound', { headers: { [bridgeApi.HELPER_TOKEN_HEADER]: helperToken }, body });
      assert.equal(noNonce.body.code, 'NONCE_REQUIRED');
      const headers = asHelper();
      assert.equal((await call('POST', '/api/bridge/helper/inbound', { headers, body })).status, 202);
      assert.equal((await call('POST', '/api/bridge/helper/inbound', { headers, body })).body.code, 'NONCE_REUSED');
    });

    it('the helper token opens nothing but the helper routes', async () => {
      for (const [method, apiPath] of [
        ['GET', '/api/bridge/master/status'], ['GET', '/api/bridge/master/routes'],
        ['GET', '/api/bridge/operator/status'], ['POST', '/api/bridge/operator/disable']
      ]) {
        const r = await call(method, apiPath, { headers: asHelper() });
        assert.ok([401, 403].includes(r.status), `${method} ${apiPath} answered ${r.status}`);
      }
    });

    it('a credential is taken only from a request made directly from this machine', async () => {
      const routeId = (await operatorSays(`m${++seq}`, '@master hello')).body.routeId;
      // Through a proxy: the headers one leaves behind are enough to refuse, whatever credential comes with them.
      for (const proxied of [{ 'x-forwarded-for': '203.0.113.9' }, { forwarded: 'for=203.0.113.9' }, { via: '1.1 caddy' }, { 'x-real-ip': '203.0.113.9' }, { 'x-forwarded-proto': 'https' }]) {
        const asM = await call('GET', '/api/bridge/master/status', { headers: { ...asMaster(), ...proxied } });
        const asH = await call('POST', '/api/bridge/helper/outbound/claim', { headers: { ...asHelper(), ...proxied }, body: {} });
        assert.deepEqual([asM.status, asM.body.code, asH.status, asH.body.code], [403, 'LOOPBACK_REQUIRED', 403, 'LOOPBACK_REQUIRED'], Object.keys(proxied)[0]);
      }
      // From another machine: judged on the socket, before the credential is looked at.
      const remote = (address) => ({ socket: { remoteAddress: address }, headers: {} });
      for (const address of ['203.0.113.9', '10.0.0.5', '::ffff:10.0.0.5', undefined]) {
        const m = await bridgeApi.handle(bridgeApi.routeFor('GET', '/api/bridge/master/routes/:routeId'), { req: remote(address), headers: asMaster(), params: { routeId } });
        const h = await bridgeApi.handle(bridgeApi.routeFor('POST', '/api/bridge/helper/inbound'), { req: remote(address), headers: asHelper(), body: { externalId: `m${++seq}`, ...ALLOWED, text: 'x' } });
        assert.deepEqual([m.status, m.body.code, h.status, h.body.code], [403, 'LOOPBACK_REQUIRED', 403, 'LOOPBACK_REQUIRED'], String(address));
      }
      for (const address of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
        const m = await bridgeApi.handle(bridgeApi.routeFor('GET', '/api/bridge/master/status'), { req: remote(address), headers: asMaster() });
        assert.equal(m.status, 200, address);
      }
      assert.ok(bridgeStore.masterCredentials.live(), 'a refused request spends nothing: the credential is still live');

      // `tc` does not send the credential anywhere but this machine in the first place.
      const away = await tc(['bridge', 'status'], { TANGLECLAW_API: 'http://tc.example.invalid:3102' });
      assert.deepEqual([away.code, away.stdout], [2, '']);
      assert.match(away.stderr, /works only against the TangleClaw server on this machine.*The credential was not sent/);
      assert.ok(!away.stderr.includes(masterCredential));
    });

    it('a Master that tmux says is gone loses its credential on the spot; an unanswered probe changes nothing', async () => {
      const master = gateway._deps.master();
      const withLiveness = (liveness) => { gateway._deps.master = () => ({ ...master, masterLiveness: () => liveness }); };
      try {
        withLiveness({ live: false, answered: false, cause: 'tmux did not answer' });
        assert.equal((await call('GET', '/api/bridge/master/status', { headers: asMaster() })).status, 200, 'tmux not answering is not the Master being gone');
        assert.ok(bridgeStore.masterCredentials.live());

        withLiveness({ live: false, answered: true, cause: null });
        const refused = await call('GET', '/api/bridge/master/status', { headers: asMaster() });
        assert.deepEqual([refused.status, refused.body.code], [401, 'BRIDGE_CREDENTIAL_REQUIRED']);
        assert.equal(bridgeStore.masterCredentials.live(), null, 'and the credential is revoked');
        const why = store.getDb().prepare("SELECT revoke_reason FROM bridge_master_credentials WHERE status = 'revoked' ORDER BY generation DESC LIMIT 1").get();
        assert.equal(why.revoke_reason, 'master-not-live');

        // Even if a Master appears again, that credential is spent: a new Master gets a new one.
        withLiveness({ live: true, answered: true, cause: null });
        assert.equal((await call('GET', '/api/bridge/master/status', { headers: asMaster() })).status, 401);
      } finally {
        gateway._deps.master = () => master;
      }
    });

    it('the bridge is not enabled while the Master could not be told of a message', async () => {
      const master = gateway._deps.master();
      try {
        await asOperator('POST', '/api/bridge/operator/disable');
        gateway._deps.master = () => ({ ...master, masterListenerEnabled: () => false, getMasterMedusaStatus: () => ({ state: 'off', workspaceId: null }) });
        const refused = await asOperator('POST', '/api/bridge/operator/enable');
        assert.deepEqual([refused.status, refused.body.code], [409, 'MASTER_LISTENER_OFF']);
        assert.equal(bridgeStore.settings.isEnabled(), false);
        const status = await asOperator('GET', '/api/bridge/operator/status');
        assert.deepEqual(status.body.masterListener, { enabled: false, state: 'off' });

        gateway._deps.master = () => ({ ...master, getMasterMedusaStatus: () => ({ state: 'listening', workspaceId: 'master-ws' }) });
        assert.equal((await asOperator('POST', '/api/bridge/operator/enable')).status, 200);
        const after = await asOperator('GET', '/api/bridge/operator/status');
        assert.deepEqual(after.body.masterListener, { enabled: true, state: 'listening' });
        // Counts and the oldest arrival, without a word of anything anyone wrote.
        const waiting = await operatorSays(`m${++seq}`, 'a message whose text status never shows');
        const now = await asOperator('GET', '/api/bridge/operator/status');
        assert.equal(Object.values(now.body.openRoutesByState).reduce((a, b) => a + b, 0), now.body.openRoutes);
        assert.ok(now.body.openRoutesByState[bridgeStore.routes.get(waiting.body.routeId).state] >= 1);
        assert.match(now.body.oldestOpenRouteAt, /^20\d\d-\d\d-\d\dT/);
        assert.ok(!JSON.stringify(now.body).includes('status never shows'));
        assert.equal(Number.isInteger(after.body.routesMasterNotTold), true);
      } finally {
        gateway._deps.master = () => master;
      }
    });

    it('the dashboard\'s bridge panel is served, and its status route tells a caller with no account session nothing', async () => {
      const script = await fetch(`${origin}/operator-bridge-panel.js`);
      assert.equal(script.status, 200);
      assert.match(script.headers.get('content-type'), /javascript/);
      assert.match(await script.text(), /tcMountOperatorBridge/);

      // Over HTTP, as a browser on this install would ask: same-origin, and no account session.
      for (const headers of [{}, operatorHeaders(server)]) {
        const res = await call('GET', '/api/bridge/operator/status', { headers });
        assert.deepEqual([res.status, res.body.code], [403, 'OPERATOR_SESSION_REQUIRED']);
        assert.deepEqual(Object.keys(res.body).sort(), ['code', 'error'], 'a refusal, and nothing of the bridge');
        for (const write of [['POST', 'enable'], ['POST', 'disable'], ['POST', 'helper-token'], ['DELETE', 'helper-token'], ['POST', 'candidate-primer'], ['POST', 'circuit/reset'], ['POST', 'outbound/1/withdraw']]) {
          const refused = await call(write[0], `/api/bridge/operator/${write[1]}`, { headers, body: { primed: true, requestId: 'req-unsigned-0001', decision: 'withdraw' } });
          assert.equal(refused.status, 403, write.join(' '));
          assert.ok(!JSON.stringify(refused.body).includes('bht_'), 'no token is minted for it');
        }
      }
      assert.equal(bridgeStore.settings.isEnabled(), true, 'and none of it changed anything');

      // What the panel draws from: the items set aside by id and reason, and the primer as it was set.
      const signedIn = (await asOperator('GET', '/api/bridge/operator/status')).body;
      assert.deepEqual([Array.isArray(signedIn.setAsideItems), signedIn.setAsideItems.length, signedIn.candidatePrimerSetting], [true, signedIn.setAside, false]);
      bridgeStore.settings.set('candidates.primed', 'true');
      await asOperator('POST', '/api/bridge/operator/disable');
      const off = (await asOperator('GET', '/api/bridge/operator/status')).body;
      assert.deepEqual([off.candidatesPrimed, off.candidatePrimerSetting], [false, true], 'not in effect while disabled, and still set');
      bridgeStore.settings.set('candidates.primed', 'false');
      assert.equal((await asOperator('GET', '/api/bridge/operator/status')).body.candidatePrimerSetting, false);
    });

    it('preflight answers the helper in yes, no and a closed word, changes nothing, and is asked sparingly', async () => {
      bridgeApi._resetRateLimits();
      const ask = (body, headers = { [bridgeApi.HELPER_TOKEN_HEADER]: helperToken }) => call('POST', '/api/bridge/helper/preflight', { headers, body });
      const nonces = () => store.getDb().prepare('SELECT COUNT(*) AS n FROM bridge_nonces').get().n;
      const audits = () => store.getDb().prepare('SELECT COUNT(*) AS n FROM bridge_audit').get().n;
      const before = [nonces(), audits()];

      const right = await ask(ALLOWED);
      assert.deepEqual([right.status, right.body], [200, { tokenLive: true, bridgeEnabled: true, allowlistSet: true, allowlistMatch: true, circuit: 'closed' }]);
      // One answer for all three ids together: it does not say which differs.
      for (const wrong of [{ ...ALLOWED, authorId: 'someone' }, { ...ALLOWED, channelId: 'elsewhere' }, { authorId: ALLOWED.authorId }, {}]) {
        assert.equal((await ask(wrong)).body.allowlistMatch, false);
      }
      assert.deepEqual([nonces(), audits()], before, 'it takes no nonce and writes nothing');
      assert.ok(!JSON.stringify(right.body).includes(ALLOWED.channelId), 'and gives back no id');

      // It is the helper's alone, from this machine, and still answers while the bridge is off.
      assert.equal((await ask(ALLOWED, {})).status, 401);
      assert.equal((await ask(ALLOWED, asMaster())).status, 401);
      assert.equal((await ask(ALLOWED, { [bridgeApi.HELPER_TOKEN_HEADER]: helperToken, 'x-forwarded-for': '203.0.113.9' })).body.code, 'LOOPBACK_REQUIRED');
      await asOperator('POST', '/api/bridge/operator/disable');
      bridgeApi._resetRateLimits();
      assert.equal((await ask(ALLOWED)).body.bridgeEnabled, false);

      // Six a minute from one token, then refused.
      const rest = [];
      for (let i = 0; i < 6; i++) rest.push((await ask(ALLOWED)).status);
      assert.deepEqual(rest, [200, 200, 200, 200, 200, 429]);
      assert.equal((await ask(ALLOWED)).body.code, 'RATE_LIMITED');
      bridgeApi._resetRateLimits();
    });

    it('one caller gone wrong cannot flood the bridge: each class of route has a bound', async () => {
      bridgeApi._resetRateLimits();
      assert.deepEqual(Object.fromEntries(Object.entries(bridgeApi.RATE_LIMITS).map(([name, limit]) => [name, limit.perMinute])), { helper: 600, inbound: 120, preflight: 6, candidate: 12 });
      for (const entry of bridgeApi.ROUTES) {
        const expected = entry.path.startsWith('/api/bridge/helper/') ? (entry.path.endsWith('/preflight') ? 'preflight' : (entry.path.endsWith('/inbound') ? 'inbound' : 'helper'))
          : (entry.principal === 'session' ? 'candidate' : undefined);
        assert.equal(entry.rate, expected, `${entry.method} ${entry.path}`);
      }
      // The bound is per caller and per minute of the gateway's clock.
      const realNow = gateway._deps.now;
      try {
        let t = Date.now();
        gateway._deps.now = () => new Date(t).toISOString();
        const claimOnce = () => call('POST', '/api/bridge/helper/outbound/claim', { headers: asHelper(), body: {} });
        for (let i = 0; i < 600; i++) assert.equal((await claimOnce()).status, 200, `claim ${i + 1} of the minute's 600`);
        assert.equal((await claimOnce()).status, 429);

        // A request over the bound is refused before anything is written for
        // it: no nonce is recorded, so the same request is good a minute on,
        // and the refusals are logged once for the caller, not once each.
        const nonces = () => store.getDb().prepare('SELECT COUNT(*) AS n FROM bridge_nonces').get().n;
        const lines = [];
        const nonce = crypto.randomBytes(16).toString('hex');
        const ackOnce = () => call('POST', '/api/bridge/helper/outbound/999999/ack',
          { headers: asHelper({ [bridgeApi.HELPER_NONCE_HEADER]: nonce }), body: { leaseId: 'l'.repeat(32), parts: ['1'], partCount: 1 } });
        const before = nonces();
        setLevel('warn');
        setConsoleStream({ write: (s) => { lines.push(String(s)); return true; } });
        try {
          for (let i = 0; i < 3; i++) assert.deepEqual([(await ackOnce()).status, nonces()], [429, before]);
        } finally {
          setConsoleStream(null);
          setLevel('error');
        }
        assert.equal(lines.filter((l) => l.includes('RATE_LIMITED')).length, 0, 'the 601st request was the one logged; these three were not');

        // The operator's messages have a bucket of their own: the helper's other traffic cannot spend it.
        assert.equal((await operatorSays(`m${++seq}`, 'still heard')).status, 202);

        t += 60001;
        setLevel('warn');
        setConsoleStream({ write: (s) => { lines.push(String(s)); return true; } });
        try {
          const unspent = nonces();
          const taken = await ackOnce();
          assert.ok(taken.status !== 429 && taken.body.code !== 'NONCE_REUSED', `a minute on its nonce is still its own: ${taken.status} ${taken.body.code}`);
          assert.equal(nonces(), unspent + 1);
          assert.equal((await ackOnce()).body.code, 'NONCE_REUSED');
          for (let i = 0; i < 600; i++) await claimOnce();
          assert.equal((await claimOnce()).status, 429);
          assert.equal((await claimOnce()).status, 429);
        } finally {
          setConsoleStream(null);
          setLevel('error');
        }
        assert.equal(lines.filter((l) => l.includes('RATE_LIMITED')).length, 1, 'a minute on, the caller is logged once more, and once only');

        // The inbound bucket has its own bound.
        t += 60001;
        const statuses = [];
        for (let i = 0; i < 121; i++) statuses.push((await call('POST', '/api/bridge/helper/inbound', { headers: asHelper(), body: { externalId: 'same-one', ...ALLOWED, text: 'again' } })).status);
        assert.deepEqual([statuses.slice(0, 120).every((s) => s !== 429), statuses[120]], [true, 429]);
        assert.equal((await claimOnce()).status, 200, 'and spending it does not spend the other');

        // A caller that has gone quiet is forgotten once the table is large.
        t += 60001;
        bridgeApi._resetRateLimits();
        for (let i = 0; i < bridgeApi.ADMITTED_SWEEP_AT; i++) bridgeApi._admitted.set(`helper:gone-${i}`, [t - 60001]);
        bridgeApi._admitted.set('helper:recent', [t - 1000]);
        assert.equal((await claimOnce()).status, 200);
        assert.deepEqual([...bridgeApi._admitted.keys()].filter((k) => k.startsWith('helper:gone-')), []);
        assert.ok(bridgeApi._admitted.has('helper:recent'), 'a caller seen in the last minute is kept');
      } finally {
        gateway._deps.now = realNow;
        bridgeApi._resetRateLimits();
      }
    });

    it('telling every pane of `tc candidate` is the operator\'s switch, and only while the bridge is on', async () => {
      const primer = require('../lib/ecosystem-primer');
      const pane = { projectId: 77, projectName: 'Some-Project', apiOrigin: 'http://localhost:3102', operatorHost: 'example-host.tail0000.ts.net' };
      const named = () => primer.buildEcosystemPrimerSection(pane).join('\n').includes('`candidate`');
      const set = (primed, req) => bridgeApi.handle(bridgeApi.routeFor('POST', '/api/bridge/operator/candidate-primer'),
        { req: req || SIGNED_IN, headers: (req || SIGNED_IN).headers, body: { primed } });
      assert.deepEqual([bridgeApi.candidatesPrimed(), named()], [false, false], 'off until somebody switches it on');

      assert.equal((await set(true, AMBIENT)).status, 403, 'a dashboard-shaped request on an open gate switches nothing');
      assert.equal((await set('yes')).body.code, 'BAD_PRIMER');
      await asOperator('POST', '/api/bridge/operator/disable');
      assert.deepEqual([(await set(true)).status, (await set(true)).body.code], [409, 'BRIDGE_DISABLED']);
      assert.equal((await asOperator('POST', '/api/bridge/operator/enable')).status, 200);

      const on = await set(true);
      assert.deepEqual([on.status, on.body.candidatesPrimed, bridgeApi.candidatesPrimed(), named()], [200, true, true, true],
        'the server reads the switch each time a pane\'s instructions are written');
      const told = (await asOperator('GET', '/api/bridge/operator/status')).body;
      assert.deepEqual([told.candidatesPrimed, told.candidatePrimerOmitted], [true, null]);
      // The switch is what the operator asked for. A pane whose section ran
      // over its cap was not told, and status says so: when, which project,
      // how long and against what cap, and none of the section's text.
      const long = { ...pane, projectId: 91, apiOrigin: `${pane.apiOrigin}/${'x'.repeat(60)}` };
      assert.ok(!primer.buildEcosystemPrimerSection(long).join('\n').includes('`candidate`'));
      const omitted = (await asOperator('GET', '/api/bridge/operator/status')).body.candidatePrimerOmitted;
      assert.deepEqual([omitted.projectId, omitted.switches, omitted.cap, omitted.length > 2820, Object.keys(omitted).sort()],
        [91, ['bridge-candidates'], 2820, true, ['at', 'cap', 'length', 'projectId', 'switches']]);
      assert.match(omitted.at, /^20\d\d-\d\d-\d\dT/);

      // Switching the bridge off takes the verb out of the list with it, and switching it back on brings it back.
      await asOperator('POST', '/api/bridge/operator/disable');
      assert.deepEqual([bridgeApi.candidatesPrimed(), named()], [false, false]);
      await asOperator('POST', '/api/bridge/operator/enable');
      assert.equal(named(), true);
      assert.deepEqual([(await set(false)).body.candidatesPrimed, named()], [false, false]);
      const audited = store.getDb().prepare("SELECT op, proof, detail_json FROM bridge_audit WHERE op LIKE 'candidate-primer-%' ORDER BY audit_seq").all();
      assert.deepEqual(audited.map((r) => [r.op, r.proof, JSON.parse(r.detail_json).user]),
        [['candidate-primer-on', 'verified-session', 'rosie'], ['candidate-primer-off', 'verified-session', 'rosie']]);
    });

    it('the Master credential opens neither the helper routes nor the operator routes', async () => {
      assert.equal((await claim(asMaster())).status, 401);
      assert.equal((await call('POST', '/api/bridge/operator/enable', { headers: asMaster() })).status, 403);
    });

    it('the helper token is created only where its one showing cannot be read on the way: https, this machine, or this machine\'s own proxy saying https', async () => {
      const mint = (req) => bridgeApi.handle(bridgeApi.routeFor('POST', '/api/bridge/operator/helper-token'), { req: { ...SIGNED_IN, ...req }, headers: (req && req.headers) || {} });
      const db = store.getDb();
      const state = () => ({
        active: db.prepare('SELECT token_id FROM bridge_helper_tokens WHERE revoked_at IS NULL').all().map((r) => r.token_id),
        mints: db.prepare("SELECT COUNT(*) AS n FROM bridge_audit WHERE op = 'helper-token-mint'").get().n
      });
      await asOperator('POST', '/api/bridge/operator/disable');
      await asOperator('DELETE', '/api/bridge/operator/helper-token');
      const before = state();
      assert.deepEqual(before.active, []);

      // Refused, each of them the signed-in operator: nothing created, nothing audited as created, no secret in the answer.
      const REFUSED = [
        ['plain http from another machine', { socket: { remoteAddress: '100.64.0.9' } }],
        ['plain http from another machine on the LAN', { socket: { remoteAddress: '192.168.1.20', encrypted: false } }],
        ['a peer elsewhere that says it is forwarding https', { socket: { remoteAddress: '100.64.0.9' }, headers: { 'x-forwarded-proto': 'https' } }],
        ['a peer elsewhere that says it is forwarding for this machine', { socket: { remoteAddress: '100.64.0.9' }, headers: { 'x-forwarded-proto': 'https', 'x-forwarded-for': '127.0.0.1' } }],
        ['this machine\'s proxy forwarding plain http', { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-proto': 'http', 'x-forwarded-for': '100.64.0.9' } }],
        ['this machine\'s proxy saying nothing of the scheme', { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '100.64.0.9' } }],
        ['a scheme list whose first hop was plain http', { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-proto': 'http, https' } }],
        ['a request with no socket to judge', { socket: undefined }],
        ['"encrypted" that is not true', { socket: { remoteAddress: '100.64.0.9', encrypted: 'yes' } }]
      ];
      for (const [why, req] of REFUSED) {
        const r = await mint(req);
        assert.deepEqual([r.status, r.body.code], [403, 'SECURE_TRANSPORT_REQUIRED'], why);
        assert.deepEqual(Object.keys(r.body).sort(), ['code', 'error'], `${why}: the answer carries no token and no token id`);
        assert.deepEqual(state(), before, `${why}: no token exists and no creation was recorded`);
      }
      // Allowed: each makes exactly one active token and returns it once.
      const ALLOWED_TRANSPORTS = [
        ['plain http on this machine itself', { socket: { remoteAddress: '127.0.0.1' } }],
        ['plain http on this machine over IPv6', { socket: { remoteAddress: '::1' } }],
        ['https this server terminated, from anywhere', { socket: { remoteAddress: '100.64.0.9', encrypted: true } }],
        ['this machine\'s proxy saying the browser came over https', { socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-proto': 'https', 'x-forwarded-for': '100.64.0.9' } }],
        ['the same, as the first of a list', { socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: { 'x-forwarded-proto': 'HTTPS, http' } }]
      ];
      let mints = before.mints;
      for (const [why, req] of ALLOWED_TRANSPORTS) {
        const r = await mint(req);
        assert.equal(r.status, 201, why);
        assert.ok(r.body.token.startsWith(gateway.HELPER_TOKEN_PREFIX), why);
        mints += 1;
        assert.deepEqual(state(), { active: [r.body.tokenId], mints }, `${why}: one active token, one creation recorded`);
      }
      // A signature on the request is still required first: transport does not stand in for the operator.
      const ambient = await bridgeApi.handle(bridgeApi.routeFor('POST', '/api/bridge/operator/helper-token'), { req: { ...AMBIENT, socket: { remoteAddress: '127.0.0.1' } }, headers: {} });
      assert.equal(ambient.body.code, 'OPERATOR_SESSION_REQUIRED');
    });

    it('operator policy needs a signed-in operator: an open gate and a dashboard-shaped request are refused', async () => {
      // Over HTTP on a scratch store the gate is open, so this request is the
      // operator in appearance only.
      for (const [method, apiPath] of [
        ['GET', '/api/bridge/operator/status'], ['POST', '/api/bridge/operator/enable'], ['POST', '/api/bridge/operator/disable'],
        ['POST', '/api/bridge/operator/allowlist'], ['POST', '/api/bridge/operator/helper-token'],
        ['DELETE', '/api/bridge/operator/helper-token'], ['POST', '/api/bridge/operator/aliases'],
        ['DELETE', '/api/bridge/operator/aliases/x'], ['POST', '/api/bridge/operator/pins'], ['DELETE', '/api/bridge/operator/pins/x']
      ]) {
        const r = await call(method, apiPath, { headers: operatorHeaders(server), body: method === 'POST' ? {} : undefined });
        assert.deepEqual([r.status, r.body.code], [403, 'OPERATOR_SESSION_REQUIRED'], `${method} ${apiPath}`);
      }
      const ambient = await bridgeApi.handle(bridgeApi.routeFor('POST', '/api/bridge/operator/disable'), { req: AMBIENT, headers: {} });
      assert.equal(ambient.body.code, 'OPERATOR_SESSION_REQUIRED');
      assert.equal(bridgeStore.settings.isEnabled(), true, 'the refused request changed nothing');
      assert.ok(gateway.verifyHelperToken(helperToken), 'and revoked nothing');
    });

    it('a signed-in operator\'s changes are audited with who made them, and never with a secret', async () => {
      const status = await asOperator('GET', '/api/bridge/operator/status');
      assert.deepEqual([status.status, status.body.enabled, status.body.allowlist], [200, true, ALLOWED]);
      assert.deepEqual(status.body.droppedArrivals, { count: 0, recent: [] });
      assert.ok(!JSON.stringify(status.body).includes(helperToken));

      assert.equal((await asOperator('POST', '/api/bridge/operator/aliases', { body: { alias: 'Master', to: 'master' } })).body.code, 'ALIAS_RESERVED');
      assert.equal((await asOperator('POST', '/api/bridge/operator/aliases', { body: { alias: 'boss', to: 'master' } })).status, 200);
      assert.equal((await asOperator('DELETE', '/api/bridge/operator/aliases/:alias', { params: { alias: 'boss' } })).status, 200);

      const rows = store.getDb().prepare("SELECT * FROM bridge_audit WHERE actor = 'operator'").all();
      assert.ok(rows.length >= 5);
      assert.ok(rows.every((r) => r.proof === 'verified-session' && JSON.parse(r.detail_json).user === 'rosie'));
      const dump = JSON.stringify(rows);
      assert.ok(!dump.includes(helperToken) && !dump.includes(ALLOWED.authorId), 'no token and no chat id in the audit');
    });

    it('enabling records when, which is the line no notification looks behind', async () => {
      const bridgeNotify = require('../lib/bridge-notify');
      await asOperator('POST', '/api/bridge/operator/disable');
      const before = new Date().toISOString();
      assert.equal((await asOperator('POST', '/api/bridge/operator/enable')).status, 200);
      const enabledAt = bridgeStore.settings.get(bridgeNotify.ENABLED_AT);
      assert.ok(enabledAt >= before && enabledAt <= new Date().toISOString());
      await asOperator('POST', '/api/bridge/operator/disable');
      await asOperator('POST', '/api/bridge/operator/enable');
      assert.ok(bridgeStore.settings.get(bridgeNotify.ENABLED_AT) >= enabledAt, 'each enable moves it forward');
    });

    it('cannot be enabled before it has an allowlist and a helper token', async () => {
      await asOperator('POST', '/api/bridge/operator/disable');
      await asOperator('DELETE', '/api/bridge/operator/helper-token');
      assert.equal((await asOperator('POST', '/api/bridge/operator/enable')).body.code, 'HELPER_TOKEN_NOT_SET');
      bridgeStore.settings.set('allow.channel', null);
      assert.equal((await asOperator('POST', '/api/bridge/operator/enable')).body.code, 'ALLOWLIST_NOT_SET');
      assert.equal(bridgeStore.settings.isEnabled(), false);
    });

    it('every declared route refuses a caller with no proof, before its handler runs', async () => {
      assert.equal(new Set(bridgeApi.ROUTES.map((r) => `${r.method} ${r.path}`)).size, bridgeApi.ROUTES.length);
      for (const entry of bridgeApi.ROUTES) {
        assert.ok(['master', 'helper', 'operator', 'session'].includes(entry.principal), `${entry.method} ${entry.path} declares its principal`);
        let reached = false;
        const guarded = { ...entry, handler: () => { reached = true; return { status: 200, body: {} }; } };
        const refused = await bridgeApi.handle(guarded, { req: { headers: {} }, headers: {}, params: {}, body: {} });
        assert.ok([401, 403].includes(refused.status), `${entry.method} ${entry.path} answered ${refused.status}`);
        assert.equal(reached, false, `${entry.method} ${entry.path} ran its handler unauthenticated`);
        // And over HTTP, as registered.
        const apiPath = entry.path.replace(/:[A-Za-z]+/g, 'x');
        const http = await call(entry.method, apiPath, { body: entry.method === 'GET' ? undefined : {} });
        assert.ok([401, 403].includes(http.status), `${entry.method} ${apiPath} over HTTP answered ${http.status}`);
      }
    });

    it('a principal\'s proof opens only that principal\'s routes', async () => {
      // A verified project launch: the fourth principal.
      const project = store.projects.create({ name: `Caller${++seq}`, path: path.join(tmpDir, `Caller${seq}`) });
      const sessionHeaders = require('./_shared-docs-callers').bindProject(project).headers;
      const proofs = {
        master: { headers: asMaster(), req: { headers: {} } },
        helper: { headers: asHelper(), req: { headers: {} } },
        operator: { headers: {}, req: SIGNED_IN },
        session: { headers: sessionHeaders, req: { headers: sessionHeaders } }
      };
      for (const entry of bridgeApi.ROUTES) {
        for (const [who, proof] of Object.entries(proofs)) {
          if (who === entry.principal) continue;
          let reached = false;
          const guarded = { ...entry, handler: () => { reached = true; return { status: 200, body: {} }; } };
          await bridgeApi.handle(guarded, { ...proof, headers: who === 'helper' ? asHelper() : proof.headers, params: {}, body: {} });
          assert.equal(reached, false, `${who}'s proof reached ${entry.method} ${entry.path}`);
        }
      }
    });

    it('a disabled bridge refuses the helper and every Master write', async () => {
      const accepted = await operatorSays(`m${++seq}`, '@master hello');
      const routeId = accepted.body.routeId;
      await asOperator('POST', '/api/bridge/operator/disable');
      assert.equal((await operatorSays(`m${++seq}`, 'hello again')).body.code, 'BRIDGE_DISABLED');
      assert.equal((await claim()).body.code, 'BRIDGE_DISABLED');
      for (const op of ['route', 'answer', 'release', 'pin']) {
        assert.equal((await masterWrites(routeId, op, { expectedVersion: 1, to: 'master', text: 'x' })).body.code, 'BRIDGE_DISABLED', op);
      }
      const closed = await masterWrites(routeId, 'close', { expectedVersion: bridgeStore.routes.get(routeId).version });
      assert.equal(closed.body.route.state, 'closed', 'a held message can still be let go while the bridge is off');
    });
  });
});
