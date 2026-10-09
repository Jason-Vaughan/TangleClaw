'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const guard = require('../lib/launch-binding-guard');
const sharedDocsAccess = require('../lib/shared-docs-access');

const { KINDS, INVALID_REASONS } = sharedDocsAccess;

/**
 * Build guard lookups that answer a fixed caller and a fixed current session.
 * @param {object} access - What the resolver answers
 * @param {object|null} [current] - The project's current session
 * @returns {{deps: object, asked: number[]}} `asked` lists the project ids whose current session was read
 */
function depsFor(access, current = null) {
  const asked = [];
  return {
    asked,
    deps: {
      resolveAccess: () => access,
      currentSession: (projectId) => { asked.push(projectId); return current; }
    }
  };
}

const ROUTE = { method: 'POST', pattern: '/api/sessions/:project/command', options: {} };
const PROJECT = { kind: KINDS.PROJECT, projectId: 48, groupIds: [], reason: null, sessionId: 488, launchId: 'L-488' };

describe('launch-binding guard: who may reach a mutating route (#2233)', () => {
  it('does not judge a read', () => {
    const { deps } = depsFor({ kind: KINDS.UNBOUND });
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      assert.deepEqual(guard.judge({}, { ...ROUTE, method }, deps), { allowed: true, via: 'not-mutating' });
    }
  });

  it('judges every mutating method, in any letter case', () => {
    const { deps } = depsFor({ kind: KINDS.UNBOUND, reason: null });
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'post', 'Delete']) {
      assert.equal(guard.judge({}, { ...ROUTE, method }, deps).allowed, false, method);
    }
  });

  it('admits the operator and the Project Master without reading any session', () => {
    for (const kind of [KINDS.OPERATOR, KINDS.MASTER]) {
      const { deps, asked } = depsFor({ kind, projectId: null, groupIds: [], reason: null });
      const verdict = guard.judge({}, ROUTE, deps);
      assert.equal(verdict.allowed, true);
      assert.equal(verdict.via, kind);
      assert.deepEqual(asked, []);
    }
  });

  it('refuses a request with no launch id', () => {
    const { deps } = depsFor({ kind: KINDS.UNBOUND, projectId: null, groupIds: [], reason: null });
    const verdict = guard.judge({}, ROUTE, deps);
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.status, 403);
    assert.equal(verdict.code, 'LAUNCH_BINDING_REQUIRED');
    assert.equal(verdict.reason, 'unbound');
    assert.match(verdict.message, /tc whoami/);
  });

  for (const reason of Object.values(INVALID_REASONS)) {
    it(`refuses an invalid binding and carries its reason: ${reason}`, () => {
      const { deps, asked } = depsFor({ kind: KINDS.INVALID, projectId: null, groupIds: [], reason });
      const verdict = guard.judge({}, ROUTE, deps);
      assert.equal(verdict.allowed, false);
      assert.equal(verdict.code, 'LAUNCH_BINDING_INVALID');
      assert.equal(verdict.reason, reason);
      assert.deepEqual(asked, [], 'an invalid binding names no project to look up');
    });
  }

  it('refuses a caller kind it does not know rather than passing it', () => {
    const { deps } = depsFor({ kind: 'something-new', reason: null });
    const verdict = guard.judge({}, ROUTE, deps);
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.code, 'LAUNCH_BINDING_INVALID');
  });

  it('admits a project whose verified session is its current session', () => {
    const { deps, asked } = depsFor(PROJECT, { id: 488 });
    const verdict = guard.judge({}, ROUTE, deps);
    assert.equal(verdict.allowed, true);
    assert.equal(verdict.via, KINDS.PROJECT);
    assert.deepEqual(asked, [48], 'the current session is read for the project the STORE recorded');
  });

  it('refuses an ACTIVE session that is not its project\'s current session', () => {
    const { deps } = depsFor(PROJECT, { id: 490 });
    const verdict = guard.judge({}, ROUTE, deps);
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.code, 'LAUNCH_BINDING_INVALID');
    assert.equal(verdict.reason, 'session-not-current');
  });

  it('refuses when the project has no current session at all', () => {
    const { deps } = depsFor(PROJECT, null);
    assert.equal(guard.judge({}, ROUTE, deps).reason, 'session-not-current');
  });

  it('lets a listed exception through without asking who is calling', () => {
    let resolved = 0;
    const deps = { resolveAccess: () => { resolved += 1; return { kind: KINDS.UNBOUND }; }, currentSession: () => null };
    for (const key of Object.keys(guard.EXCEPTIONS)) {
      const [method, pattern] = key.split(' ');
      const verdict = guard.judge({}, { method, pattern, options: {} }, deps);
      assert.equal(verdict.allowed, true, key);
      assert.equal(verdict.via, guard.EXCEPTIONS[key].kind);
    }
    assert.equal(resolved, 0);
  });

  it('matches an exception on method and pattern together', () => {
    const { deps } = depsFor({ kind: KINDS.UNBOUND, reason: null });
    assert.equal(guard.judge({}, { method: 'DELETE', pattern: '/api/auth/login', options: {} }, deps).allowed, false);
    assert.equal(guard.judge({}, { method: 'POST', pattern: '/api/auth/login/extra', options: {} }, deps).allowed, false);
  });

  it('honours a route that declares its own principal, and only an exact true', () => {
    const { deps } = depsFor({ kind: KINDS.UNBOUND, reason: null });
    const own = guard.judge({}, { ...ROUTE, options: { ownPrincipal: true } }, deps);
    assert.deepEqual(own, { allowed: true, via: guard.EXCEPTION_KINDS.OWN_PRINCIPAL });
    for (const value of ['true', 1, {}, null, undefined]) {
      assert.equal(guard.judge({}, { ...ROUTE, options: { ownPrincipal: value } }, deps).allowed, false, String(value));
    }
  });

  describe('a verified service token', () => {
    const unbound = () => depsFor({ kind: KINDS.UNBOUND, reason: null }).deps;

    it('is a principal on each port write, and only when the dispatcher verified it', () => {
      for (const key of guard.SERVICE_TOKEN_ROUTES) {
        const [method, pattern] = key.split(' ');
        assert.deepEqual(guard.judge({}, { method, pattern, options: {}, serviceTokenVerified: true }, unbound()),
          { allowed: true, via: 'service-token' }, key);
        for (const value of [false, undefined, 'true', 1]) {
          assert.equal(guard.judge({}, { method, pattern, options: {}, serviceTokenVerified: value }, unbound()).allowed,
            false, `${key} with ${String(value)}`);
        }
      }
    });

    it('covers the port writes and nothing else', () => {
      assert.deepEqual([...guard.SERVICE_TOKEN_ROUTES].sort(), [
        'POST /api/ports/heartbeat', 'POST /api/ports/lease', 'POST /api/ports/owner-kind',
        'POST /api/ports/release', 'POST /api/ports/sync'
      ]);
    });

    it('is not a principal anywhere else, shared documents included', () => {
      for (const pattern of ['/api/shared-docs', '/api/groups/:id/sync', '/api/sessions/:project/command', '/api/config']) {
        assert.equal(guard.judge({}, { method: 'POST', pattern, options: {}, serviceTokenVerified: true }, unbound()).allowed,
          false, pattern);
      }
    });
  });

  describe('an ended launch repeating its own finalize', () => {
    const FINALIZE = { method: 'POST', pattern: '/api/sessions/:project/finalize', options: {}, params: { project: 'IT Manager' } };
    const ENDED = { kind: KINDS.INVALID, projectId: null, groupIds: [], reason: INVALID_REASONS.SESSION_NOT_ACTIVE };
    const req = (launchId = 'L-488', project = '48') => ({
      headers: { 'x-tangleclaw-launch-id': launchId, 'x-tangleclaw-project-id': project }
    });

    /**
     * Guard lookups for an ended launch, with any fact overridden.
     * @param {object} [over] - Replacement lookups
     * @returns {object}
     */
    function ended(over = {}) {
      return {
        resolveAccess: () => ENDED,
        currentSession: () => null,
        getLaunch: (id) => (id === 'L-488' ? { projectId: 48, sessionId: 488 } : null),
        getSession: (id) => (id === 488 ? { id: 488, projectId: 48, status: 'wrapped' } : null),
        projectByName: (name) => (name === 'IT Manager' ? { id: 48 } : name === 'Task Manager' ? { id: 73 } : null),
        finalizedByGovernedPath: () => true,
        ...over
      };
    }

    it('is admitted for its own project', () => {
      assert.deepEqual(guard.judge(req(), FINALIZE, ended()), { allowed: true, via: 'ended-own-launch' });
    });

    it('is refused on another project\'s finalize route', () => {
      const verdict = guard.judge(req(), { ...FINALIZE, params: { project: 'Task Manager' } }, ended());
      assert.equal(verdict.allowed, false);
      assert.equal(verdict.reason, INVALID_REASONS.SESSION_NOT_ACTIVE);
    });

    it('is refused when the route names no project, or one that does not exist', () => {
      assert.equal(guard.judge(req(), { ...FINALIZE, params: { project: 'Nobody' } }, ended()).allowed, false);
      assert.equal(guard.judge(req(), { ...FINALIZE, params: {} }, ended()).allowed, false);
      assert.equal(guard.judge(req(), { ...FINALIZE, params: undefined }, ended()).allowed, false);
    });

    it('is refused when the project it claims is not the launch\'s, whatever the resolver said', () => {
      assert.equal(guard.judge(req('L-488', '73'), FINALIZE, ended()).allowed, false);
      assert.equal(guard.judge(req('L-488', 'forty-eight'), FINALIZE, ended()).allowed, false);
    });

    it('is refused for a launch id the store does not hold', () => {
      assert.equal(guard.judge(req('L-unknown'), FINALIZE, ended()).allowed, false);
      assert.equal(guard.judge({ headers: {} }, FINALIZE, ended()).allowed, false);
    });

    it('is refused while its session is still ACTIVE: a superseded launch is not an ended one', () => {
      const deps = ended({ getSession: () => ({ id: 488, projectId: 48, status: 'active' }) });
      assert.equal(guard.judge(req(), FINALIZE, deps).allowed, false);
    });

    it('is refused unless this finalize path is what ended its session', () => {
      assert.equal(guard.judge(req(), FINALIZE, ended({ finalizedByGovernedPath: () => false })).allowed, false,
        'a session the wrap ended, or whose summary only imitates this path');
      for (const answer of [undefined, null, 'yes', 1]) {
        assert.equal(guard.judge(req(), FINALIZE, ended({ finalizedByGovernedPath: () => answer })).allowed, false, String(answer));
      }
      for (const status of ['killed', 'crashed', 'ended', 'active']) {
        const deps = ended({ getSession: () => ({ id: 488, projectId: 48, status }) });
        assert.equal(guard.judge(req(), FINALIZE, deps).allowed, false, status);
      }
    });

    it('asks about the launch\'s own session, never one the request names', () => {
      const asked = [];
      const deps = ended({ finalizedByGovernedPath: (session) => { asked.push(session.id); return true; } });
      guard.judge(req(), FINALIZE, deps);
      assert.deepEqual(asked, [488]);
    });

    it('is refused when its session row is missing or belongs to another project', () => {
      assert.equal(guard.judge(req(), FINALIZE, ended({ getSession: () => null })).allowed, false);
      assert.equal(guard.judge(req(), FINALIZE, ended({ getSession: () => ({ id: 488, projectId: 73, status: 'wrapped' }) })).allowed, false);
    });

    it('is refused on every other mutating route', () => {
      for (const pattern of ['/api/sessions/:project/command', '/api/sessions/:project/wrap', '/api/sessions/:project/medusa/send']) {
        const verdict = guard.judge(req(), { ...FINALIZE, pattern }, ended());
        assert.equal(verdict.allowed, false, pattern);
        assert.equal(verdict.code, 'LAUNCH_BINDING_INVALID');
      }
      assert.equal(guard.judge(req(), { ...FINALIZE, method: 'DELETE' }, ended()).allowed, false);
    });

    it('applies only to the ended reason: no other refusal is turned into a pass', () => {
      for (const reason of Object.values(INVALID_REASONS)) {
        if (reason === INVALID_REASONS.SESSION_NOT_ACTIVE) continue;
        const deps = ended({ resolveAccess: () => ({ ...ENDED, reason }) });
        assert.equal(guard.judge(req(), FINALIZE, deps).allowed, false, reason);
      }
      assert.equal(guard.judge(req(), FINALIZE, ended({ resolveAccess: () => ({ kind: KINDS.UNBOUND, reason: null }) })).allowed, false);
    });

    it('lists the finalize route and nothing else', () => {
      assert.deepEqual([...guard.ENDED_LAUNCH_ROUTES], ['POST /api/sessions/:project/finalize']);
    });
  });

  it('gives every exception a kind it defines and a reason', () => {
    const kinds = new Set(Object.values(guard.EXCEPTION_KINDS));
    for (const [key, entry] of Object.entries(guard.EXCEPTIONS)) {
      assert.ok(kinds.has(entry.kind), key);
      assert.ok(typeof entry.why === 'string' && entry.why.length > 10, key);
      assert.match(key, /^(POST|PUT|PATCH|DELETE) \/api\//, key);
    }
  });
});
