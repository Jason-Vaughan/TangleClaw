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
  'POST /api/audit/heartbeat',
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

  it('guards every state-changing merge queue route: an unidentified caller reaches none (#2322)', () => {
    const queueRoutes = MUTATING.filter((r) => r.pattern.startsWith('/api/merge-queue')).map(key).sort();
    assert.deepEqual(queueRoutes, [
      'POST /api/merge-queue',
      'POST /api/merge-queue/:id/clear-halt',
      'POST /api/merge-queue/advance',
      'POST /api/merge-queue/entries',
      'POST /api/merge-queue/entries/:id/operator-gate',
      'POST /api/merge-queue/entries/:id/settle-landing',
      'POST /api/merge-queue/entries/:id/withdraw'
    ]);
    for (const queueRoute of queueRoutes) assert.ok(!admitted.includes(queueRoute), `${queueRoute} must not be reachable unidentified`);
  });

  it('guards both state-changing check watch routes: an unidentified caller reaches neither (#2323)', () => {
    const watchRoutes = MUTATING.filter((r) => r.pattern.startsWith('/api/tc/check-watches')).map(key).sort();
    assert.deepEqual(watchRoutes, [
      'POST /api/tc/check-watches',
      'POST /api/tc/check-watches/:id/cancel'
    ]);
    for (const watchRoute of watchRoutes) assert.ok(!admitted.includes(watchRoute), `${watchRoute} must not be reachable unidentified`);
  });

  it('guards every state-changing launch-isolation override route: an unidentified caller reaches none (#2229)', () => {
    const overrideRoutes = MUTATING.filter((r) => r.pattern.startsWith('/api/launch/isolation-overrides')).map(key).sort();
    assert.deepEqual(overrideRoutes, [
      'DELETE /api/launch/isolation-overrides/install',
      'DELETE /api/launch/isolation-overrides/projects/:id',
      'PUT /api/launch/isolation-overrides/install',
      'PUT /api/launch/isolation-overrides/projects/:id'
    ]);
    for (const overrideRoute of overrideRoutes) assert.ok(!admitted.includes(overrideRoute), `${overrideRoute} must not be reachable unidentified`);
  });

  it('guards the shared-doc attestation route: an unidentified caller can neither capture a base nor attest (#2389)', () => {
    assert.ok(MUTATING.some((r) => key(r) === 'POST /api/shared-docs/:id/attest'), 'the attest route is registered as mutating');
    assert.ok(!admitted.includes('POST /api/shared-docs/:id/attest'), 'the attest route must not be reachable unidentified');
  });

  it('guards both notice-setting routes: an unidentified caller can mute or subscribe no one (#2389)', () => {
    for (const noticeRoute of ['POST /api/shared-docs/:id/notices', 'POST /api/groups/:id/notices']) {
      assert.ok(MUTATING.some((r) => key(r) === noticeRoute), `${noticeRoute} is registered as mutating`);
      assert.ok(!admitted.includes(noticeRoute), `${noticeRoute} must not be reachable unidentified`);
    }
  });

  it('admits the audit heartbeat unidentified, exactly as ingest is, now that it proves its own credential too (#2239)', () => {
    assert.ok(MUTATING.some((r) => key(r) === 'POST /api/audit/heartbeat'));
    assert.ok(admitted.includes('POST /api/audit/heartbeat'),
      'an unidentified caller must reach the handler so a valid audit-secret Bearer token can be checked there; ' +
      'the handler itself refuses a caller with neither that token nor a verified launch binding/operator proof ' +
      '(test/api-audit.test.js covers the handler-level refusal)');
  });
});

// The operator routes that grant or approve authority over sessions, each of
// which needs the operator signed in (#2378). On an install with no login the
// operator is recognised by a request's shape, which any process on the host
// can send; these routes refuse that. Adding a route here, or taking one off,
// is a decision about what that shape may authorize. It is made here, in
// review, and not by registering a route.
const SIGNED_IN_OPERATOR = Object.freeze([
  'DELETE /api/session-rules/:id',
  'POST /api/caddy-drift/resolve',
  'POST /api/control/assignments/:id/close',
  'POST /api/control/assignments/:id/release',
  'POST /api/coordinator-roles',
  'POST /api/groups/:id/members',
  'POST /api/master/rules/restore-defaults',
  'POST /api/merge-queue',
  'POST /api/merge-queue/:id/clear-halt',
  'POST /api/merge-queue/entries/:id/operator-gate',
  'POST /api/merge-queue/entries/:id/settle-landing',
  'POST /api/rules/global/reset',
  'POST /api/session-rules',
  'POST /api/session-rules/:id/restore',
  'POST /api/session-rules/promote',
  'PUT /api/launch/isolation-overrides/install',
  'PUT /api/launch/isolation-overrides/projects/:id',
  'PUT /api/learnings/:id/tier',
  'PUT /api/rules/global',
  'PUT /api/session-rules/:id',
  'PUT /api/session-rules/:id/status',
  'PUT /api/shared-docs/:id',
  'PUT /api/startup-prompt'
]);

// The route that needs a signed-in operator on one branch only (choosing a
// project's launch recovery mode); its handler asks, so it carries no option.
const SIGNED_IN_OPERATOR_BRANCH = Object.freeze(['PATCH /api/projects/:name']);

describe('signed-in operator routes: the reviewed list is the route table (#2378)', () => {
  const marked = ROUTES.filter((r) => r.options && r.options.signedInOperator);

  it('marks exactly the reviewed routes', () => {
    assert.deepEqual(marked.map(key).sort(), [...SIGNED_IN_OPERATOR].sort());
  });

  it('marks only mutating routes, none of which the guard admits without the operator being judged', () => {
    const skipping = new Set([...Object.keys(guard.EXCEPTIONS), ...guard.SERVICE_TOKEN_ROUTES, ...guard.ENDED_LAUNCH_ROUTES]);
    for (const r of marked) {
      assert.ok(guard.isMutating(r.method), `${key(r)} is marked and is not mutating`);
      assert.ok(!skipping.has(key(r)), `${key(r)} is marked and sits on a guard exception list`);
      assert.notEqual(r.options.ownPrincipal, true, `${key(r)} is marked and proves its own principal`);
    }
  });

  it('gives every marked route the action its refusal names', () => {
    for (const r of marked) {
      const action = r.options.signedInOperator.action;
      assert.equal(typeof action, 'string', key(r));
      assert.ok(action.trim().length > 0, key(r));
    }
  });

  it('keeps the branch-level route registered, mutating and unmarked', () => {
    for (const listed of SIGNED_IN_OPERATOR_BRANCH) {
      const r = MUTATING.find((x) => key(x) === listed);
      assert.ok(r, `${listed} is not a registered mutating route`);
      assert.ok(!r.options.signedInOperator, `${listed} would refuse every branch if it were marked`);
    }
  });
});
