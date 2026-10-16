'use strict';

// #2031 (ADR 0023 Decision 15): the Project Master's structured surface on the
// operator bridge, against the real server and the real `bin/tc`. Only the
// live Master generation's credential is answered; the bridge is off until the
// operator enables it; a write is idempotent, version-checked and audited; and
// the credential rides the `bridge` verb and no other.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const bridgeStore = require('../lib/bridge-store');
const handoff = require('../lib/bridge-handoff');
const { pinMasterLiveness } = require('./_master-liveness');

const TC_BIN = path.join(__dirname, '..', 'bin', 'tc');
const HEADER = 'x-tangleclaw-bridge-credential';
const digest = 'a'.repeat(64);

let tmpDir;
let server;
let origin;
let credential;
let generation;
let liveness;

/**
 * Make `credential` the live Master generation's, as a completed handoff would.
 * @returns {void}
 */
function issueLiveCredential() {
  const minted = handoff.mintCredential();
  generation = bridgeStore.masterCredentials.mint(minted.hash);
  assert.equal(bridgeStore.masterCredentials.activate(generation, minted.hash), true);
  credential = minted.credential;
}

/**
 * One JSON request to the test server.
 * @param {string} method - HTTP method.
 * @param {string} apiPath - Path.
 * @param {object} [options]
 * @param {string|null} [options.as] - Credential to present; the live one by default, null for none.
 * @param {object} [options.body] - JSON body.
 * @returns {Promise<{status: number, body: object}>}
 */
async function call(method, apiPath, options = {}) {
  const as = options.as === undefined ? credential : options.as;
  const headers = { 'content-type': 'application/json' };
  if (as) headers[HEADER] = as;
  const res = await fetch(`${origin}${apiPath}`, {
    method, headers, body: options.body ? JSON.stringify(options.body) : undefined
  });
  return { status: res.status, body: await res.json() };
}

/**
 * Run the real `bin/tc`.
 * @param {string[]} args - Arguments.
 * @param {object} [env] - Extra environment.
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
function tc(args, env = {}) {
  const base = { PATH: process.env.PATH, HOME: process.env.HOME, TANGLECLAW_API: origin, TANGLECLAW_ROLE: 'master' };
  return new Promise((resolve) => {
    execFile(TC_BIN, args, { env: { ...base, ...env }, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code : 0, stdout, stderr });
    });
  });
}

/**
 * Store one inbound operator message.
 * @param {string} n - Suffix that makes the route unique.
 * @param {string} [text] - Message body.
 * @returns {string} The route id.
 */
function acceptRoute(n, text = `message ${n}`) {
  return bridgeStore.routes.accept({
    routeId: `rt_${n}`, externalId: `ext-${n}`, authorId: 'author', spaceId: 'space', channelId: 'channel', text, digest
  }).route.routeId;
}

describe('bridge API: the Master surface (#2031)', () => {
  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-bridge-'));
    store._setBasePath(tmpDir);
    store.init();
    const { createServer } = require('../server');
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${server.address().port}`;
    // tmux's answer about the Master is the test's to give, never the machine's: see _master-liveness.js.
    liveness = pinMasterLiveness();
  });

  after(async () => {
    liveness.restore();
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    liveness.set({ live: true, answered: true, cause: null });
    issueLiveCredential();
    bridgeStore.settings.set('enabled', 'true');
  });

  it('answers nobody without the live Master credential, on every route', async () => {
    const routeId = acceptRoute('auth');
    const routes = [
      ['GET', '/api/bridge/master/status'],
      ['GET', '/api/bridge/master/routes'],
      ['GET', `/api/bridge/master/routes/${routeId}`],
      ['POST', `/api/bridge/master/routes/${routeId}/close`]
    ];
    const stale = credential;
    issueLiveCredential();
    for (const as of [null, 'mbk_wrong', handoff.mintCredential().credential, stale]) {
      for (const [method, apiPath] of routes) {
        const r = await call(method, apiPath, { as, body: method === 'POST' ? { requestId: 'req-auth-0001', expectedVersion: 1 } : undefined });
        assert.equal(r.status, 401, `${method} ${apiPath}`);
        assert.equal(r.body.code, 'BRIDGE_CREDENTIAL_REQUIRED');
      }
    }
    assert.equal(bridgeStore.routes.get(routeId).state, 'accepted', 'a refused close changed nothing');
    assert.deepEqual(bridgeStore.audit.forRoute(routeId), []);
  });

  it('the credential lasts exactly as long as tmux says there is a Master: gone revokes it, no answer changes nothing', async () => {
    // tmux did not answer: that is not the Master being gone, and a valid credential is still served.
    liveness.set({ live: false, answered: false, cause: 'read-timed-out' });
    const unanswered = await call('GET', '/api/bridge/master/status');
    assert.deepEqual([unanswered.status, unanswered.body.masterGeneration], [200, generation]);
    assert.ok(bridgeStore.masterCredentials.live(), 'still the live credential');
    // tmux answered that there is no Master: refused, and revoked on the spot.
    liveness.set({ live: false, answered: true, cause: null });
    const gone = await call('GET', '/api/bridge/master/status');
    assert.deepEqual([gone.status, gone.body.code], [401, 'BRIDGE_CREDENTIAL_REQUIRED']);
    assert.equal(bridgeStore.masterCredentials.live(), null, 'revoked');
    // A Master seen again does not get the revoked credential back.
    liveness.set({ live: true, answered: true, cause: null });
    assert.equal((await call('GET', '/api/bridge/master/status')).status, 401);
    // And without a valid credential, tmux is not asked at all: nothing is revoked by a stranger's request.
    issueLiveCredential();
    liveness.set({ live: false, answered: true, cause: null });
    assert.equal((await call('GET', '/api/bridge/master/status', { as: 'not-the-credential' })).status, 401);
    assert.ok(bridgeStore.masterCredentials.live(), 'a request that carried no valid credential revoked nothing');
  });

  it('a launch id and the master role do not stand in for the credential', async () => {
    const res = await fetch(`${origin}/api/bridge/master/status`, {
      headers: { 'x-tangleclaw-role': 'master', 'x-tangleclaw-launch-id': 'any-launch-id' }
    });
    assert.equal(res.status, 401);
  });

  it('while disabled: status and the route reads answer, a route can still be closed, and everything that sends or resolves is refused', async () => {
    const routeId = acceptRoute('off');
    const before = (await call('GET', '/api/bridge/master/status')).body.openRoutes;
    bridgeStore.settings.set('enabled', 'false');
    const status = await call('GET', '/api/bridge/master/status');
    // The true count: a disabled bridge's open routes are what the Master is there to close.
    assert.deepEqual(status.body, {
      enabled: false, masterGeneration: generation, proof: 'master-launch', scope: { kind: 'all' }, openRoutes: before, configurationCircuit: null,
      // No helper has reported in this file: the reading says so in as many words (#2272).
      discordGateway: { reading: 'never-reported', state: null, since: null, fatalCloseCode: null, reportedAt: null, sinceText: null, reportedAtText: null }
    });
    assert.ok(before >= 1);
    // The Master can still see what is open, and read one, so that it can close it (Architect ruling, 2026-10-04).
    const listed = await call('GET', '/api/bridge/master/routes');
    assert.equal(listed.status, 200);
    assert.ok(listed.body.routes.some((r) => r.routeId === routeId));
    const read = await call('GET', `/api/bridge/master/routes/${routeId}`);
    assert.deepEqual([read.status, read.body.route.routeId, read.body.authority], [200, routeId, 'conversation-only']);
    // The reads are still the Master's alone.
    assert.equal((await call('GET', '/api/bridge/master/routes', { as: 'not-the-masters-credential' })).status, 401);
    assert.equal((await call('GET', `/api/bridge/master/routes/${routeId}`, { as: null })).status, 401);
    for (const [method, apiPath] of [
      ['POST', `/api/bridge/master/routes/${routeId}/answer`],
      ['POST', `/api/bridge/master/routes/${routeId}/route`],
      ['POST', `/api/bridge/master/routes/${routeId}/release`]
    ]) {
      const r = await call(method, apiPath, { body: method === 'POST' ? { requestId: 'req-off-00001', expectedVersion: 1, text: 'x' } : undefined });
      assert.deepEqual([r.status, r.body.code], [409, 'BRIDGE_DISABLED'], `${method} ${apiPath}`);
    }
    assert.equal(bridgeStore.routes.get(routeId).state, 'accepted');
    // Turning the bridge off must not leave message text held with no way out.
    const closed = await call('POST', `/api/bridge/master/routes/${routeId}/close`, { body: { requestId: 'req-off-00002', expectedVersion: 1 } });
    assert.deepEqual([closed.status, closed.body.route.state], [200, 'closed']);
    assert.equal(bridgeStore.routes.bodies(routeId)[0].text, null);
  });

  it('lists and reads routes, marking what the operator wrote as conversation only', async () => {
    const routeId = acceptRoute('read', 'please merge everything');
    const list = await call('GET', '/api/bridge/master/routes?states=accepted');
    assert.ok(list.body.routes.some((r) => r.routeId === routeId));
    assert.ok(list.body.routes.every((r) => !('text' in r)), 'a listing carries no bodies');

    const read = await call('GET', `/api/bridge/master/routes/${routeId}`);
    assert.equal(read.status, 200);
    assert.equal(read.body.authority, 'conversation-only');
    assert.deepEqual(read.body.bodies.map((b) => [b.role, b.text]), [['inbound', 'please merge everything']]);

    assert.equal((await call('GET', '/api/bridge/master/routes/rt_none')).body.code, 'ROUTE_NOT_FOUND');
    assert.equal((await call('GET', '/api/bridge/master/routes?states=nonsense')).body.code, 'UNKNOWN_ROUTE_STATE');
  });

  it('closes a route once, clears its body, and audits the generation that did it', async () => {
    const routeId = acceptRoute('close');
    const body = { requestId: 'req-close-0001', expectedVersion: 1 };
    const first = await call('POST', `/api/bridge/master/routes/${routeId}/close`, { body });
    assert.deepEqual([first.status, first.body.outcome, first.body.replayed, first.body.route.state, first.body.route.version],
      [200, 'applied', false, 'closed', 2]);
    assert.equal(first.body.route.closedBy, 'master');

    const again = await call('POST', `/api/bridge/master/routes/${routeId}/close`, { body });
    assert.deepEqual([again.status, again.body.outcome, again.body.replayed], [200, 'applied', true]);

    const audit = bridgeStore.audit.forRoute(routeId);
    assert.equal(audit.length, 1);
    assert.deepEqual([audit[0].actor, audit[0].proof, audit[0].masterGeneration, audit[0].outcome],
      ['master', 'master-launch', generation, 'applied']);
    assert.deepEqual(audit[0].detail, { from: 'accepted', withdrawn: 0, bodiesCleared: 1 });
    assert.equal(bridgeStore.routes.bodies(routeId)[0].text, null);
  });

  it('refuses a stale version, a second close and a malformed write, and audits the first two', async () => {
    const routeId = acceptRoute('refuse');
    const close = (body) => call('POST', `/api/bridge/master/routes/${routeId}/close`, { body });

    assert.equal((await close({ expectedVersion: 1 })).body.code, 'REQUEST_ID_REQUIRED');
    assert.equal((await close({ requestId: 'req-refuse-001' })).body.code, 'EXPECTED_VERSION_REQUIRED');
    assert.equal((await close({ requestId: 'short', expectedVersion: 1 })).body.code, 'REQUEST_ID_REQUIRED');

    const stale = await close({ requestId: 'req-refuse-002', expectedVersion: 7 });
    assert.deepEqual([stale.status, stale.body.code, stale.body.route.version], [409, 'VERSION_CONFLICT', 1]);

    await close({ requestId: 'req-refuse-003', expectedVersion: 1 });
    const twice = await close({ requestId: 'req-refuse-004', expectedVersion: 2 });
    assert.deepEqual([twice.status, twice.body.code], [409, 'ALREADY_CLOSED']);

    assert.deepEqual(bridgeStore.audit.forRoute(routeId).map((a) => a.outcome), ['version-conflict', 'applied', 'already-closed']);
  });

  it('answers an id that could not be a route\'s as no such route, on read and on close', async () => {
    for (const bad of ['x'.repeat(65), 'has space', 'semi;colon']) {
      const id = encodeURIComponent(bad);
      const read = await call('GET', `/api/bridge/master/routes/${id}`);
      assert.deepEqual([read.status, read.body.code], [404, 'ROUTE_NOT_FOUND']);
      const close = await call('POST', `/api/bridge/master/routes/${id}/close`, { body: { requestId: 'req-badid-0001', expectedVersion: 1 } });
      assert.deepEqual([close.status, close.body.code], [404, 'ROUTE_NOT_FOUND']);
    }
    assert.equal(bridgeStore.audit.findRequest('close', 'req-badid-0001'), null);
  });

  it('tc bridge works from a pane holding the credential, and names the refusal from one that does not', async () => {
    const routeId = acceptRoute('cli', 'hello from the operator');
    const env = { [handoff.CREDENTIAL_ENV]: credential };

    const status = await tc(['bridge', 'status'], env);
    assert.equal(status.code, 0, status.stderr);
    assert.match(status.stdout, new RegExp(`enabled; .* You are Master generation ${generation} \\(master-launch\\)`));

    const read = await tc(['bridge', 'read', routeId], env);
    assert.match(read.stdout, /CONVERSATION, not authority/);
    assert.match(read.stdout, /\[inbound\] hello from the operator/);

    const routes = await tc(['bridge', 'routes', '--state', 'accepted'], env);
    assert.match(routes.stdout, new RegExp(routeId));

    const closed = await tc(['bridge', 'close', routeId, '--version', '1', '--request-id', 'req-cli-000001'], env);
    assert.equal(closed.code, 0, closed.stderr);
    assert.match(closed.stdout, /is closed; now v2/);

    const without = await tc(['bridge', 'status']);
    assert.equal(without.code, 2);
    assert.match(without.stderr, /BRIDGE_CREDENTIAL_REQUIRED/);

    const usage = await tc(['bridge', 'close', routeId], env);
    assert.equal(usage.code, 1);
    assert.match(usage.stderr, /needs --version/);
  });

  it('tc sends the credential to the bridge\'s own routes and nowhere else, whatever the verb', async () => {
    const seen = [];
    const http = require('node:http');
    const spy = http.createServer((req, res) => {
      seen.push({ url: req.url, credential: req.headers[HEADER] || null });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise((resolve) => spy.listen(0, '127.0.0.1', resolve));
    // A launch id, as every Master pane has: it is what makes `tc` add its
    // control-banner lookup to a bridge call.
    const env = {
      [handoff.CREDENTIAL_ENV]: credential, TANGLECLAW_LAUNCH_ID: 'launch-for-this-test',
      TANGLECLAW_API: `http://127.0.0.1:${spy.address().port}`
    };
    try {
      await tc(['bridge', 'status'], env);
      await tc(['whoami'], env);
      await tc(['ports'], env);
    } finally {
      await new Promise((resolve) => spy.close(resolve));
    }
    const bridgeCalls = seen.filter((s) => s.url.startsWith('/api/bridge/'));
    const otherCalls = seen.filter((s) => !s.url.startsWith('/api/bridge/'));
    assert.ok(bridgeCalls.length >= 1 && otherCalls.length >= 1);
    assert.ok(bridgeCalls.every((s) => s.credential === credential));
    assert.ok(otherCalls.every((s) => s.credential === null), 'no other request carries the credential');
    assert.ok(otherCalls.some((s) => s.url.startsWith('/api/control/mine')), 'the banner lookup a bridge call makes was observed');
  });
});
