'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const server = require('../server');
const guard = require('../lib/launch-binding-guard');
const bridgeApi = require('../lib/bridge-api');
const { KINDS } = require('../lib/shared-docs-access');

// The routes as the running server registered them, dynamic registrations
// included. Read from the route table, never from the source text: the bridge
// and control routes are registered in loops a text scan cannot see.
const ROUTES = server._routePatterns();
const MUTATING = ROUTES.filter((r) => guard.isMutating(r.method));
const key = (r) => `${r.method} ${r.pattern}`;

// A caller the guard must refuse, so a route that still passes was let through
// by an exception and by nothing else.
const UNBOUND = { resolveAccess: () => ({ kind: KINDS.UNBOUND, reason: null }), currentSession: () => null };

/** The routes an unidentified caller reaches, as `METHOD pattern`. */
const admitted = MUTATING
  .filter((r) => guard.judge({ headers: {} }, { method: r.method, pattern: r.pattern, options: r.options }, UNBOUND).allowed)
  .map(key)
  .sort();

// Every mutating route an unidentified caller may reach, and why. Adding a
// route to this list is a decision about who may change state without saying
// who they are; it is made here, in review, and not by registering a route.
const LISTED = Object.freeze([
  'POST /api/audit/ingest',
  'POST /api/auth/login',
  'POST /api/auth/logout',
  'POST /api/auth/recover',
  'POST /api/auth/set-password',
  'POST /api/tc/rule-receipt',
  'POST /api/tc/start/next',
  'POST /api/tc/start/ready'
]);

describe('launch-binding guard: every mutating route is guarded or listed (#2233)', () => {
  it('finds the mutating routes, the dynamically registered ones included', () => {
    assert.ok(MUTATING.length > 100, `only ${MUTATING.length} mutating routes found`);
    assert.ok(MUTATING.some((r) => r.pattern.startsWith('/api/bridge/')), 'bridge routes are in the table');
    assert.ok(MUTATING.some((r) => r.pattern.startsWith('/api/control/')), 'control routes are in the table');
    assert.ok(MUTATING.some((r) => /\/medusa\/send$/.test(r.pattern)), 'Medusa routes are in the table');
  });

  it('lets an unidentified caller reach exactly the listed routes and the bridge\'s own-credential routes', () => {
    const ownCredential = bridgeApi.ROUTES
      .filter((entry) => guard.isMutating(entry.method) && bridgeApi.provesOwnPrincipal(entry))
      .map((entry) => `${entry.method} ${entry.path}`);
    assert.deepEqual(admitted, [...LISTED, ...ownCredential].sort());
  });

  it('holds every listed exception to a route that exists', () => {
    const registered = new Set(MUTATING.map(key));
    for (const listed of [...Object.keys(guard.EXCEPTIONS), ...guard.SERVICE_TOKEN_ROUTES, ...guard.ENDED_LAUNCH_ROUTES]) {
      assert.ok(registered.has(listed), `${listed} is on a guard list and is not a registered mutating route`);
    }
  });

  it('matches the guard\'s exception list to the list reviewed here', () => {
    assert.deepEqual(Object.keys(guard.EXCEPTIONS).sort(), [...LISTED].sort());
  });

  it('marks own-principal only on bridge routes, and only the Master\'s and the helper\'s', () => {
    const marked = MUTATING.filter((r) => r.options && r.options.ownPrincipal === true);
    assert.ok(marked.length > 0);
    for (const r of marked) {
      const entry = bridgeApi.ROUTES.find((e) => e.method === r.method && e.path === r.pattern);
      assert.ok(entry, `${key(r)} is marked own-principal and is not a declared bridge route`);
      assert.ok(['master', 'helper'].includes(entry.principal), `${key(r)} is marked own-principal for "${entry.principal}"`);
    }
    for (const entry of bridgeApi.ROUTES.filter((e) => ['operator', 'session'].includes(e.principal))) {
      const r = ROUTES.find((x) => x.method === entry.method && x.pattern === entry.path);
      assert.notEqual(r.options.ownPrincipal, true, `${entry.method} ${entry.path} must be held to the floor`);
    }
  });

  it('does not take a principal the bridge does not declare, or an entry it did not declare, as proof', () => {
    assert.deepEqual([...bridgeApi.OWN_CREDENTIAL_PRINCIPALS], ['master', 'helper']);
    const declared = bridgeApi.ROUTES.find((e) => e.principal === 'master');
    assert.equal(bridgeApi.provesOwnPrincipal(declared), true);
    assert.equal(bridgeApi.provesOwnPrincipal({ ...declared }), false, 'a copy is not a declared entry');
    assert.equal(bridgeApi.provesOwnPrincipal({ method: 'POST', path: '/api/bridge/x', principal: 'somebody-new' }), false);
    for (const principal of ['operator', 'session']) {
      const entry = bridgeApi.ROUTES.find((e) => e.principal === principal);
      assert.equal(bridgeApi.provesOwnPrincipal(entry), false, principal);
    }
  });

  it('keeps the audit heartbeat guarded: it has no credential of its own', () => {
    assert.ok(MUTATING.some((r) => key(r) === 'POST /api/audit/heartbeat'));
    assert.ok(!admitted.includes('POST /api/audit/heartbeat'));
  });
});
