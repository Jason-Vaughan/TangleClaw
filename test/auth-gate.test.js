'use strict';

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const authGate = require('../lib/auth-gate');
const caddy = require('../lib/caddy');

// A stand-in for `store.authSessions`, built from what the GATE reads rather
// than from the real store — the guard's fixture must come from a different
// authority than the code it guards, or a bug in the store makes the gate's
// test agree with it.
const sessions = (loginable) => ({ anyLoginableUser: () => loginable });
const throwingSessions = () => ({
  anyLoginableUser() { throw new Error('database is not open'); }
});

describe('lib/auth-gate — the front-door verdict (#1418, ADR 0015/0016)', () => {
  describe('isGateActive', () => {
    // The armed memory is process-wide, so each case starts from a clean one —
    // otherwise an earlier case that armed the gate changes what a later case's
    // error path answers, and the suite would depend on its own ordering.
    beforeEach(() => authGate._resetArmedMemory());

    it('is active with authEnabled and an enabled account', () => {
      assert.equal(
        authGate.isGateActive(() => ({ authEnabled: true }), sessions(true)),
        true
      );
    });

    it('is DORMANT when authEnabled is on but no account exists', () => {
      // The chunk's own decision, and the one that keeps this change from
      // locking the operator out of the live install on the first boot after
      // it merges: every caddy-mode install carries authEnabled:true with a
      // BCRYPT basicAuthHash and zero user rows, so a gate demanding a session
      // would have no account to issue one against.
      assert.equal(
        authGate.isGateActive(() => ({ authEnabled: true }), sessions(false)),
        false
      );
    });

    it('is inactive when authEnabled is off, even with accounts', () => {
      // ADR 0009's opt-out survives: an operator can still run with no login.
      assert.equal(
        authGate.isGateActive(() => ({ authEnabled: false }), sessions(true)),
        false
      );
    });

    it('treats a MISSING authEnabled as off, not as truthy', () => {
      assert.equal(authGate.isGateActive(() => ({}), sessions(true)), false);
    });

    it('requires authEnabled to be exactly true, not merely truthy', () => {
      // A config file is operator-editable JSON; "true" and 1 are things people
      // type. Accepting them would mean the gate turns on for a value the
      // rest of the codebase treats as not-set.
      for (const v of ['true', 1, 'yes', {}]) {
        assert.equal(
          authGate.isGateActive(() => ({ authEnabled: v }), sessions(true)), false,
          `authEnabled=${JSON.stringify(v)} must not activate the gate`
        );
      }
    });

    it('does not enforce when config reads back as null', () => {
      // A SUCCESSFUL read of nothing — not an error — so this answer is
      // unconditional and does not depend on whether the gate was ever armed.
      assert.equal(authGate.isGateActive(() => null, sessions(true)), false);
      authGate.isGateActive(() => ({ authEnabled: true }), sessions(true)); // arm it
      assert.equal(authGate.isGateActive(() => null, sessions(true)), false);
    });

    it('does not enforce, and does not throw, when the store is unreadable WHILE DORMANT', () => {
      // The armed case answers the other way — see the fail-closed block below.
      assert.equal(authGate.isGateActive(() => ({ authEnabled: true }), throwingSessions()), false);
    });

    it('does not enforce when reading config THROWS while dormant', () => {
      assert.equal(
        authGate.isGateActive(() => { throw new Error('corrupt'); }, sessions(true)),
        false
      );
    });

    it('asks the cheap question first and never reads config when dormant', () => {
      // A performance contract, not a style preference: this runs on every
      // request including every static asset, and `store.config.load()` is an
      // existsSync + readFileSync + JSON.parse with no cache. An install with
      // no accounts — which is every install today — must pay no file I/O.
      let configReads = 0;
      const loadConfig = () => { configReads++; return { authEnabled: true }; };
      authGate.isGateActive(loadConfig, sessions(false));
      assert.equal(configReads, 0, 'config must not be read when no account exists');
      authGate.isGateActive(loadConfig, sessions(true));
      assert.equal(configReads, 1, 'config IS read once the account question passes');
    });
  });

  describe('isGateActive fails CLOSED once the gate has been armed', () => {
    // Before it is armed, failing open leaves the install as protected as it was
    // before this module existed. After it is armed, the install is RELYING on
    // this door, so a transient read error must not silently remove it.
    beforeEach(() => authGate._resetArmedMemory());

    it('fails open on a store error while still dormant', () => {
      assert.equal(authGate.isGateActive(() => ({ authEnabled: true }), throwingSessions()), false);
    });

    it('fails CLOSED on a store error after the gate has been live once', () => {
      assert.equal(authGate.isGateActive(() => ({ authEnabled: true }), sessions(true)), true);
      assert.equal(authGate.isGateActive(() => ({ authEnabled: true }), throwingSessions()), true,
        'an armed install must not be silently un-gated by a store fault');
    });

    it('fails CLOSED on a config error after the gate has been live once', () => {
      assert.equal(authGate.isGateActive(() => ({ authEnabled: true }), sessions(true)), true);
      assert.equal(
        authGate.isGateActive(() => { throw new Error('corrupt'); }, sessions(true)), true);
    });

    it('still lets authEnabled:false turn the gate off after it was armed', () => {
      // The recovery lever must keep working — that is a successful READ of a
      // false value, not an error, so it is not the fail-closed path.
      assert.equal(authGate.isGateActive(() => ({ authEnabled: true }), sessions(true)), true);
      assert.equal(authGate.isGateActive(() => ({ authEnabled: false }), sessions(true)), false);
    });

    it('still goes dormant when the last account is disabled after arming', () => {
      assert.equal(authGate.isGateActive(() => ({ authEnabled: true }), sessions(true)), true);
      assert.equal(authGate.isGateActive(() => ({ authEnabled: true }), sessions(false)), false);
    });
  });

  describe('isMachineClient — the fleet carve-out', () => {
    // `bin/tc`, PortHub, shared-docs and the switchboard all reach TangleClaw on
    // the loopback listener with no cookie and no way to be handed one. Without
    // this, creating an account refuses every one of them.
    it('is true for a loopback, non-browser, cookieless request', () => {
      assert.equal(authGate.isMachineClient({
        loopback: true, browserShaped: false, hasSessionCookie: false
      }), true);
    });

    it('is FALSE off loopback — the carve-out is local processes only', () => {
      assert.equal(authGate.isMachineClient({
        loopback: false, browserShaped: false, hasSessionCookie: false
      }), false);
    });

    it('is FALSE for anything browser-shaped', () => {
      // A browser cannot suppress Sec-Fetch-Site from script, so a page cannot
      // disguise itself as the CLI.
      assert.equal(authGate.isMachineClient({
        loopback: true, browserShaped: true, hasSessionCookie: false
      }), false);
    });

    it('is FALSE when a session cookie is present', () => {
      // A signed-in browser is a person, and must stay subject to the CSRF
      // check rather than slipping into the machine path by dropping a header.
      assert.equal(authGate.isMachineClient({
        loopback: true, browserShaped: false, hasSessionCookie: true
      }), false);
    });

    it('requires every condition explicitly — a missing field is not a pass', () => {
      assert.equal(authGate.isMachineClient({}), false);
      assert.equal(authGate.isMachineClient({ loopback: true }), true);
      assert.equal(authGate.isMachineClient({ loopback: 'yes' }), false);
    });
  });

  describe('isLoginSurfacePath', () => {
    it('covers the login page and the three auth routes', () => {
      for (const p of ['/login', '/api/auth/login', '/api/auth/logout', '/api/auth/me']) {
        assert.equal(authGate.isLoginSurfacePath(p), true, `${p} must be exempt`);
      }
    });

    it('does NOT cover the Caddy credential routes', () => {
      // A different door. `/api/auth/credential` manages Caddy's basic_auth
      // credential and must stay behind the gate — an exemption there would let
      // an unauthenticated caller read or rewrite the admin credential.
      assert.equal(authGate.isLoginSurfacePath('/api/auth/credential'), false);
    });

    it('does not cover ordinary paths', () => {
      for (const p of ['/', '/api/config', '/api/projects', '/terminal/x', '/loginish']) {
        assert.equal(authGate.isLoginSurfacePath(p), false, `${p} must NOT be exempt`);
      }
    });

    it('canonicalises the way the Caddy bypass does', () => {
      // Without this, `//login` and `/api/auth/%6Cogin` are different strings
      // to a Set and the same route to the router — the normalisation-parity
      // leak class of #472/#473, which cost this project two rounds to close on
      // the Caddy side.
      assert.equal(authGate.isLoginSurfacePath('//login'), true);
      assert.equal(authGate.isLoginSurfacePath('/x/../login'), true);
      assert.equal(authGate.isLoginSurfacePath('/api/auth/%6Cogin'), true);
      assert.equal(authGate.isLoginSurfacePath('/login?next=/'), true);
    });

    it('is a separate list from the Caddy bypass, and the two are disjoint', () => {
      // Two exemption lists answering two different questions — "what does
      // Caddy wave through" and "what does a logged-out person need in order to
      // log in". Merging them would mean an addition to one silently widening
      // the other, so nothing may sit on both: a path on both lists is exempt
      // for a reason that only one of the two lists is reviewed against.
      for (const p of authGate.LOGIN_SURFACE_PATHS) {
        assert.equal(caddy.isCaddyAuthBypassPath(p), false,
          `${p} is a login-surface path and must not ALSO be a Caddy bypass path`);
      }
      // And the reverse: a Caddy bypass path is not silently a login route.
      for (const p of ['/api/health', '/manifest.json', '/openclaw-direct/x']) {
        assert.equal(caddy.isCaddyAuthBypassPath(p), true, `precondition: ${p} is a bypass path`);
        assert.equal(authGate.isLoginSurfacePath(p), false,
          `${p} is a Caddy bypass path and must not also be a login-surface path`);
      }
    });
  });

  describe('evaluate', () => {
    const base = {
      method: 'GET', rawUrl: '/', pathname: '/',
      gateActive: true, session: null, submittedCsrf: null,
      // Off unless a case asks for it: the default subject of these cases is a
      // browser, and leaving it on would wave every one of them through.
      machineClient: false
    };
    const ev = (over) => authGate.evaluate({ ...base, ...over });
    const SESSION = { csrfToken: 'tok', username: 'rosie' };

    it('allows everything when the gate is not active', () => {
      assert.deepEqual(ev({ gateActive: false }), { action: 'allow' });
      assert.deepEqual(
        ev({ gateActive: false, method: 'POST', pathname: '/api/config' }),
        { action: 'allow' }
      );
    });

    it('challenges an unauthenticated page request with the login document', () => {
      assert.deepEqual(ev({}), { action: 'challenge', as: 'html' });
    });

    it('challenges an unauthenticated API request with JSON', () => {
      assert.deepEqual(
        ev({ rawUrl: '/api/config', pathname: '/api/config' }),
        { action: 'challenge', as: 'json' }
      );
    });

    it('allows a Caddy bypass path unauthenticated', () => {
      assert.deepEqual(
        ev({ rawUrl: '/api/health', pathname: '/api/health' }),
        { action: 'allow' }
      );
    });

    it('allows the login surface unauthenticated', () => {
      assert.deepEqual(ev({ rawUrl: '/login', pathname: '/login' }), { action: 'allow' });
      assert.deepEqual(
        ev({ method: 'POST', rawUrl: '/api/auth/login', pathname: '/api/auth/login' }),
        { action: 'allow' }
      );
    });

    it('allows an authenticated request to anything', () => {
      assert.deepEqual(
        ev({ session: SESSION, rawUrl: '/api/config', pathname: '/api/config' }),
        { action: 'allow' }
      );
      assert.deepEqual(
        ev({ session: SESSION, rawUrl: '/terminal/x', pathname: '/terminal/x' }),
        { action: 'allow' }
      );
    });

    it('gates the proxy prefixes, which are not routes', () => {
      // `/terminal/*` proxies to a writable ttyd — that socket is a shell — and
      // `/openclaw/*` carries the operator's gateway token. Neither is a route,
      // so both are gated only by the gate standing ahead of every branch.
      for (const p of ['/terminal/x', '/openclaw/proj/api', '/plans/p/f.md']) {
        assert.deepEqual(ev({ rawUrl: p, pathname: p }), { action: 'challenge', as: 'html' },
          `${p} must be gated`);
      }
    });

    describe('CSRF', () => {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        it(`refuses ${method} from a session with no token`, () => {
          assert.deepEqual(
            ev({ method, session: SESSION, submittedCsrf: null }),
            { action: 'refuse-csrf' }
          );
        });

        it(`refuses ${method} from a session with the WRONG token`, () => {
          assert.deepEqual(
            ev({ method, session: SESSION, submittedCsrf: 'nope' }),
            { action: 'refuse-csrf' }
          );
        });

        it(`allows ${method} from a session with the right token`, () => {
          assert.deepEqual(
            ev({ method, session: SESSION, submittedCsrf: 'tok' }),
            { action: 'allow' }
          );
        });
      }

      it('does NOT apply to a request with no session', () => {
        // A request carrying no session is riding no ambient authority, so it
        // is not a CSRF vector — which is exactly what keeps curl, the tc CLI
        // and the documented agent-facing API working untouched.
        assert.deepEqual(
          ev({ method: 'POST', rawUrl: '/api/config', pathname: '/api/config' }),
          { action: 'challenge', as: 'json' }
        );
      });

      it('does not apply to a GET, however authenticated', () => {
        assert.deepEqual(ev({ method: 'GET', session: SESSION }), { action: 'allow' });
      });

      it('applies to an EXEMPT path too — logout is checked, not waved through', () => {
        // The reason CSRF is evaluated ahead of the allow-list. Without that
        // ordering `POST /api/auth/logout` would be exempt from the check
        // because its path is exempt from the gate, and any page on the
        // internet could sign the operator out.
        assert.deepEqual(
          ev({
            method: 'POST', rawUrl: '/api/auth/logout', pathname: '/api/auth/logout',
            session: SESSION, submittedCsrf: null
          }),
          { action: 'refuse-csrf' }
        );
      });

      it('does NOT apply to the login route — its authority is the body', () => {
        // Without this exemption a browser still holding a live session cannot
        // submit the login form at all: the form posts no CSRF header, so the
        // check refuses it with a 403 the person cannot resolve, on the one
        // page they visit when something is already wrong.
        assert.deepEqual(
          ev({
            method: 'POST', rawUrl: '/api/auth/login', pathname: '/api/auth/login',
            session: SESSION, submittedCsrf: null
          }),
          { action: 'allow' }
        );
      });

      it('applies the login exemption on the canonical path, not the raw string', () => {
        // Or `//api/auth/login` would be CSRF-checked while `/api/auth/login`
        // was not — the two are the same route to the router.
        assert.deepEqual(
          ev({
            method: 'POST', rawUrl: '//api/auth/login', pathname: '/api/auth/login',
            session: SESSION, submittedCsrf: null
          }),
          { action: 'allow' }
        );
      });

      it('exempts ONLY login — logout is not on that list', () => {
        // The boundary. Logout's authority IS the cookie, so an unprotected
        // logout lets any page on the internet sign the operator out.
        assert.equal(authGate.CSRF_EXEMPT_PATHS.has('/api/auth/logout'), false);
        assert.deepEqual([...authGate.CSRF_EXEMPT_PATHS], ['/api/auth/login']);
      });

      it('applies on a Caddy bypass path as well', () => {
        assert.deepEqual(
          ev({
            method: 'POST', rawUrl: '/openclaw-direct/x', pathname: '/openclaw-direct/x',
            session: SESSION, submittedCsrf: 'wrong'
          }),
          { action: 'refuse-csrf' }
        );
      });
    });
  });
});
