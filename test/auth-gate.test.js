'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const authGate = require('../lib/auth-gate');
const caddy = require('../lib/caddy');

// A stand-in for `store.authSessions`, built from what the GATE reads rather
// than from the real store — the guard's fixture must come from a different
// authority than the code it guards, or a bug in the store makes the gate's
// test agree with it.
const presence = (exists, loginable) => ({ accountPresence: () => ({ exists, loginable }) });
const NO_ACCOUNTS = presence(false, false);
const ENABLED = presence(true, true);
const ALL_DISABLED = presence(true, false);
const throwingSessions = () => ({
  accountPresence() { throw new Error('database is not open'); }
});
const S = authGate.GATE_STATES;
const on = () => ({ authEnabled: true });

describe('lib/auth-gate — the front-door verdict (#1418, #1420, ADR 0015/0016)', () => {
  describe('resolveGateState', () => {
    it('is armed with authEnabled and an enabled account', () => {
      assert.equal(authGate.resolveGateState(on, ENABLED), S.ARMED);
    });

    it('is ACCOUNT-REQUIRED, not dormant, when authEnabled is on and no account exists', () => {
      // The inversion #1420 exists for. Every install upgraded from Caddy's gate
      // carries authEnabled:true, a bcrypt basicAuthHash scrypt cannot verify,
      // and zero accounts. Answering "not gated" there is an open door the
      // moment Caddy's gate is gone, so the state is closed and offers only the
      // first-account page.
      assert.equal(authGate.resolveGateState(on, NO_ACCOUNTS), S.ACCOUNT_REQUIRED);
    });

    it('is account-required with or without a basicAuthHash — the hash is not the key', () => {
      assert.equal(
        authGate.resolveGateState(() => ({ authEnabled: true, basicAuthHash: null }), NO_ACCOUNTS),
        S.ACCOUNT_REQUIRED);
      assert.equal(
        authGate.resolveGateState(() => ({ authEnabled: true, basicAuthHash: '$2a$14$x' }), NO_ACCOUNTS),
        S.ACCOUNT_REQUIRED);
    });

    it('is LOCKED, not account-required, when accounts exist and none is enabled', () => {
      // Offering the first-account page here would be a way around the accounts
      // that already exist.
      assert.equal(authGate.resolveGateState(on, ALL_DISABLED), S.LOCKED);
    });

    it('is open when authEnabled is off, with or without accounts', () => {
      // ADR 0009's opt-out survives: an operator can still run with no login.
      for (const sessions of [NO_ACCOUNTS, ENABLED, ALL_DISABLED]) {
        assert.equal(authGate.resolveGateState(() => ({ authEnabled: false }), sessions), S.OPEN);
      }
    });

    it('treats a MISSING authEnabled as off, not as truthy', () => {
      assert.equal(authGate.resolveGateState(() => ({}), ENABLED), S.OPEN);
    });

    it('requires authEnabled to be exactly true, not merely truthy', () => {
      // A config file is operator-editable JSON; "true" and 1 are things people
      // type. Accepting them would mean the gate turns on for a value the
      // rest of the codebase treats as not-set.
      for (const v of ['true', 1, 'yes', {}]) {
        assert.equal(
          authGate.resolveGateState(() => ({ authEnabled: v }), ENABLED), S.OPEN,
          `authEnabled=${JSON.stringify(v)} must not activate the gate`
        );
      }
    });

    it('answers open when config reads back as null — a successful read of nothing', () => {
      // This is NOT the corrupt-file case: the production thunk throws there.
      assert.equal(authGate.resolveGateState(() => null, ENABLED), S.OPEN);
    });

    it('ENFORCES when reading config throws, whatever the accounts say', () => {
      for (const sessions of [NO_ACCOUNTS, ENABLED, ALL_DISABLED]) {
        assert.equal(
          authGate.resolveGateState(() => { throw new Error('corrupt'); }, sessions), S.UNREADABLE);
      }
    });

    it('ENFORCES when the store throws', () => {
      assert.equal(authGate.resolveGateState(on, throwingSessions()), S.UNREADABLE);
    });

    it('ENFORCES on a malformed store answer rather than reading it as "no accounts"', () => {
      // "No accounts" opens the first-account page; a store answer that is not
      // two booleans is not evidence of that.
      for (const bad of [null, {}, { exists: 0, loginable: 0 }, { exists: 'false', loginable: false },
        { exists: false }]) {
        assert.equal(
          authGate.resolveGateState(on, { accountPresence: () => bad }), S.UNREADABLE,
          `presence=${JSON.stringify(bad)} must enforce`);
      }
    });

    it('does not ask the store when authEnabled is off', () => {
      // An open install pays no query. Not a correctness property — the answer
      // is open either way — but the cheapest state is the most common one.
      let asked = 0;
      authGate.resolveGateState(() => ({ authEnabled: false }),
        { accountPresence: () => { asked++; return { exists: true, loginable: true }; } });
      assert.equal(asked, 0);
    });

    describe('authEnabled:false in caddy mode is honoured only while the Caddyfile is not an ungated remote door (#1420)', () => {
      const off = () => ({ authEnabled: false, ingressMode: 'caddy' });
      const door = (ungatedRemoteSite, unguardedLocalSite = false) => () => ({ ungatedRemoteSite, unguardedLocalSite });

      it('opens when the Caddyfile has a gate of its own or serves nothing remote', () => {
        for (const sessions of [NO_ACCOUNTS, ENABLED, ALL_DISABLED]) {
          assert.equal(authGate.resolveGateState(off, sessions, door(false)), S.OPEN);
        }
      });

      it('lets the accounts decide when the Caddyfile serves a remote site with no basic_auth', () => {
        assert.equal(authGate.resolveGateState(off, ENABLED, door(true)), S.ARMED);
        assert.equal(authGate.resolveGateState(off, ALL_DISABLED, door(true)), S.LOCKED);
        assert.equal(authGate.resolveGateState(off, NO_ACCOUNTS, door(true)), S.ACCOUNT_REQUIRED);
        // A missing authEnabled is off too, and gets the same answer.
        assert.equal(authGate.resolveGateState(() => ({ ingressMode: 'caddy' }), ENABLED, door(true)), S.ARMED);
      });

      it('an unguarded localhost site closes the opt-out only when accounts exist (ruled 2026-09-13)', () => {
        // A `localhost` site with no password and no peer guard answers any
        // machine that asks for `localhost`. With accounts the install had a
        // login, so the accounts decide; with none it is the opt-out install.
        assert.equal(authGate.resolveGateState(off, ENABLED, door(false, true)), S.ARMED);
        assert.equal(authGate.resolveGateState(off, ALL_DISABLED, door(false, true)), S.LOCKED);
        assert.equal(authGate.resolveGateState(off, NO_ACCOUNTS, door(false, true)), S.OPEN);
        // A remote door still wins over the local question, as before.
        assert.equal(authGate.resolveGateState(off, NO_ACCOUNTS, door(true, true)), S.ACCOUNT_REQUIRED);
      });

      it('ENFORCES when the store cannot be read while weighing an unguarded localhost site', () => {
        const broken = { accountPresence: () => { throw new Error('SQLITE_BUSY'); } };
        assert.equal(authGate.resolveGateState(off, broken, door(false, true)), S.UNREADABLE);
        for (const bad of [null, {}, { exists: 'no' }]) {
          assert.equal(authGate.resolveGateState(off, { accountPresence: () => bad }, door(false, true)), S.UNREADABLE,
            JSON.stringify(bad));
        }
      });

      it('ENFORCES when the Caddyfile cannot be read, or is described malformed', () => {
        assert.equal(authGate.resolveGateState(off, ENABLED, () => { throw new Error('EACCES'); }), S.UNREADABLE);
        for (const bad of [null, {}, { ungatedRemoteSite: 'false', unguardedLocalSite: false }, { ungatedRemoteSite: 0, unguardedLocalSite: false },
          { ungatedRemoteSite: false }, { ungatedRemoteSite: false, unguardedLocalSite: 'true' }]) {
          assert.equal(authGate.resolveGateState(off, ENABLED, () => bad), S.UNREADABLE, JSON.stringify(bad));
        }
      });

      it('never asks about the Caddyfile outside caddy mode, or with authEnabled on', () => {
        let asked = 0;
        const counting = () => { asked++; return { ungatedRemoteSite: true, unguardedLocalSite: false }; };
        assert.equal(authGate.resolveGateState(() => ({ authEnabled: false, ingressMode: 'direct' }), ENABLED, counting), S.OPEN);
        assert.equal(authGate.resolveGateState(() => ({ authEnabled: true, ingressMode: 'caddy' }), ENABLED, counting), S.ARMED);
        assert.equal(asked, 0);
      });
    });

    describe('writers resolve the gate from config, not from the file they replace (#1420 merge)', () => {
      const caddy = require('../lib/caddy');
      const fs = require('node:fs');
      const path = require('node:path');
      const off = () => ({ authEnabled: false, ingressMode: 'caddy' });
      const gen = (gateState, extra = {}) => caddy.buildCaddyfileContent({
        serverPort: 3102, certPath: '/c/cert.pem', keyPath: '/c/key.pem', gateState, ...extra
      });

      it('turning the login off in caddy mode settles on open instead of looping', () => {
        // An armed cutover's file: localhost with no basic_auth and no guard.
        const armedFile = gen(S.ARMED);
        const readFile = (text) => () => caddy.describeIngressDoor(text);
        // The request gate, with accounts, keeps the login on while that file serves.
        assert.equal(authGate.resolveGateState(off, ENABLED, readFile(armedFile)), S.ARMED);
        // A writer asking the request gate's question would write the same file again —
        assert.equal(gen(authGate.resolveGateState(off, ENABLED, readFile(armedFile))), armedFile,
          'precondition: the loop this guards against');
        // — so it asks for the configured intent instead, writes a guarded file,
        const intended = authGate.resolveIntendedGateState(off, ENABLED);
        assert.equal(intended, S.OPEN);
        const written = gen(intended);
        assert.ok(written.includes('remote_ip'), 'the new local site carries the peer guard');
        // and the request gate reading that file agrees: the opt-out took effect.
        assert.equal(authGate.resolveGateState(off, ENABLED, readFile(written)), S.OPEN);
      });

      it('keeps every failure direction: an unreadable config or store still enforces', () => {
        assert.equal(authGate.resolveIntendedGateState(() => { throw new Error('EACCES'); }, ENABLED), S.UNREADABLE);
        const broken = { accountPresence: () => { throw new Error('SQLITE_BUSY'); } };
        assert.equal(authGate.resolveIntendedGateState(() => ({ authEnabled: true }), broken), S.UNREADABLE);
        assert.equal(authGate.resolveIntendedGateState(() => ({ authEnabled: true }), ENABLED), S.ARMED);
      });

      it('both Caddyfile writers use it, and neither reads the old file for the gate', () => {
        for (const script of ['ingress-cutover.js', 'guard-ungated-sites.js']) {
          const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', script), 'utf8');
          assert.match(src, /authGate\.resolveIntendedGateState\(/, script);
          assert.doesNotMatch(src, /authGate\.resolveGateState\(/, script);
        }
      });
    });

    it('lets authEnabled:false turn an armed gate off — the recovery lever', () => {
      assert.equal(authGate.resolveGateState(on, ENABLED), S.ARMED);
      assert.equal(authGate.resolveGateState(() => ({ authEnabled: false }), ENABLED), S.OPEN);
    });

    describe('fallback — the marker, weighed last and only over an enforcing state (#1420)', () => {
      const honoured = () => ({ honoured: true, reason: null });
      const refused = () => ({ honoured: false, reason: 'no gate in front' });
      const unreadableConfig = () => { throw new Error('EACCES'); };

      it('stands the gate down over every enforcing state, unreadable included', () => {
        // `unreadable` is what a broken gate usually looks like, so the recovery
        // must reach it.
        assert.equal(authGate.resolveGateState(on, ENABLED, null, honoured), S.FALLBACK);
        assert.equal(authGate.resolveGateState(on, ALL_DISABLED, null, honoured), S.FALLBACK);
        assert.equal(authGate.resolveGateState(on, NO_ACCOUNTS, null, honoured), S.FALLBACK);
        assert.equal(authGate.resolveGateState(on, throwingSessions(), null, honoured), S.FALLBACK);
        assert.equal(authGate.resolveGateState(unreadableConfig, ENABLED, null, honoured), S.FALLBACK);
      });

      it('never replaces open, and is not even asked there', () => {
        let asked = false;
        const spy = () => { asked = true; return { honoured: true }; };
        assert.equal(authGate.resolveGateState(() => ({ authEnabled: false }), ENABLED, null, spy), S.OPEN);
        assert.equal(asked, false);
      });

      it('keeps the enforcing state when the marker is not honoured, or its check fails', () => {
        const throwing = () => { throw new Error('stat EACCES'); };
        for (const thunk of [refused, throwing, () => null, () => ({}), () => ({ honoured: 'true' }),
          () => ({ honoured: 1 }), 'not a function']) {
          assert.equal(authGate.resolveGateState(on, ENABLED, null, thunk), S.ARMED, String(thunk));
          assert.equal(authGate.resolveGateState(unreadableConfig, ENABLED, null, thunk), S.UNREADABLE,
            String(thunk));
        }
      });

      it('writers never resolve fallback — the marker is not what the operator configured', () => {
        // resolveIntendedGateState takes no fallback thunk at all.
        assert.equal(authGate.resolveIntendedGateState.length, 2);
        assert.equal(authGate.resolveIntendedGateState(on, ENABLED), S.ARMED);
      });
    });
  });

  describe('isOpen — the one definition of "nothing is enforced"', () => {
    it('is true only for exactly open', () => {
      assert.equal(authGate.isOpen('open'), true);
      for (const v of ['armed', 'account-required', 'locked', 'unreadable', 'fallback', undefined, null, '', 'OPEN', true]) {
        assert.equal(authGate.isOpen(v), false, `${JSON.stringify(v)} is not open`);
      }
    });
  });

  describe('standsDown — whether TangleClaw asks nothing of a request (#1420)', () => {
    it('is true only for exactly open and exactly fallback', () => {
      assert.equal(authGate.standsDown(S.OPEN), true);
      assert.equal(authGate.standsDown(S.FALLBACK), true);
      for (const v of [S.ARMED, S.ACCOUNT_REQUIRED, S.LOCKED, S.UNREADABLE, 'FALLBACK', 'Fallback', undefined,
        null, '', true, {}]) {
        assert.equal(authGate.standsDown(v), false, JSON.stringify(v));
      }
    });
  });

  describe('isMachineClient — the fleet carve-out', () => {
    // `bin/tc`, PortHub, shared-docs and the switchboard all reach TangleClaw on
    // the loopback listener with no cookie and no way to be handed one. Without
    // this, creating an account refuses every one of them.
    const local = { loopback: true, proxied: false, browserShaped: false, hasSessionCookie: false };

    it('is true for a loopback, unproxied, non-browser, cookieless request', () => {
      assert.equal(authGate.isMachineClient(local), true);
    });

    it('is FALSE off loopback — the carve-out is local processes only', () => {
      assert.equal(authGate.isMachineClient({ ...local, loopback: false }), false);
    });

    it('is FALSE for a request that came through a reverse proxy', () => {
      // Caddy connects to this listener from loopback, so without this every
      // off-box request it forwards would be a machine client — which is how
      // an off-box `curl` to /openclaw-direct/* got the gateway token injected.
      assert.equal(authGate.isMachineClient({ ...local, proxied: true }), false);
    });

    it('is FALSE for anything browser-shaped', () => {
      // A browser cannot suppress Sec-Fetch-Site from script, so a page cannot
      // disguise itself as the CLI.
      assert.equal(authGate.isMachineClient({ ...local, browserShaped: true }), false);
    });

    it('is FALSE when a session cookie is present', () => {
      // A signed-in browser is a person, and must stay subject to the CSRF
      // check rather than slipping into the machine path by dropping a header.
      assert.equal(authGate.isMachineClient({ ...local, hasSessionCookie: true }), false);
    });

    it('requires loopback and proxied explicitly — a missing field is not a pass', () => {
      assert.equal(authGate.isMachineClient({}), false);
      assert.equal(authGate.isMachineClient({ loopback: 'yes', proxied: false }), false);
      // The omission that would wave remote traffic through: a caller that
      // never said whether the request was proxied.
      assert.equal(authGate.isMachineClient({ loopback: true }), false);
      assert.equal(authGate.isMachineClient({ loopback: true, proxied: undefined }), false);
      assert.equal(authGate.isMachineClient({ loopback: true, proxied: 0 }), false);
      // The two remaining negatives default to absent.
      assert.equal(authGate.isMachineClient({ loopback: true, proxied: false }), true);
    });
  });

  describe('isAccountSetupPath', () => {
    it('matches the first-account route on its canonical path', () => {
      for (const p of ['/api/auth/set-password', '//api/auth/set-password',
        '/api/auth/%73et-password', '/api/x/../auth/set-password']) {
        assert.equal(authGate.isAccountSetupPath(p), true, p);
      }
    });

    it('matches nothing else', () => {
      for (const p of ['/api/auth/login', '/api/auth/set-password/x', '/api/auth/set-passwordx', '/']) {
        assert.equal(authGate.isAccountSetupPath(p), false, p);
      }
    });

    it('is NOT on the always-exempt login surface — it is exempt only while no account exists', () => {
      assert.equal(authGate.LOGIN_SURFACE_PATHS.has(authGate.ACCOUNT_SETUP_PATH), false);
      assert.equal(authGate.isLoginSurfacePath(authGate.ACCOUNT_SETUP_PATH), false);
      assert.equal(caddy.isCaddyAuthBypassPath(authGate.ACCOUNT_SETUP_PATH), false);
    });
  });

  describe('isRecoveryPath (#1420)', () => {
    it('matches the recovery page and route on their canonical paths', () => {
      for (const p of ['/recover', '/api/auth/recover', '//recover', '/api/auth/%72ecover', '/x/../recover']) {
        assert.equal(authGate.isRecoveryPath(p), true, p);
      }
    });

    it('matches nothing else', () => {
      for (const p of ['/recoverx', '/recover/x', '/api/auth/recovery-codes', '/api/auth/recover/x', '/']) {
        assert.equal(authGate.isRecoveryPath(p), false, p);
      }
    });

    it('is NOT on the always-exempt login surface or the bypass list — it is exempt only while armed', () => {
      for (const p of authGate.RECOVERY_PATHS) {
        assert.equal(authGate.isLoginSurfacePath(p), false, p);
        assert.equal(authGate.isGateBypassPath(p), false, p);
        assert.equal(caddy.isCaddyAuthBypassPath(p), false, p);
      }
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
      for (const p of authGate.GATE_BYPASS_PATHS) {
        assert.equal(caddy.isCaddyAuthBypassPath(p), true, `precondition: ${p} is a bypass path`);
        assert.equal(authGate.isLoginSurfacePath(p), false,
          `${p} is a Caddy bypass path and must not also be a login-surface path`);
      }
    });
  });

  describe('isGateBypassPath — TangleClaw\'s own list, which Caddy\'s matcher is generated from (#1420)', () => {
    it('exempts exactly the credential-less paths', () => {
      assert.deepEqual([...authGate.GATE_BYPASS_PATHS], ['/api/health', '/manifest.json']);
      for (const p of authGate.GATE_BYPASS_PATHS) {
        assert.equal(authGate.isGateBypassPath(p), true, `${p} must stay exempt`);
      }
    });

    it('does NOT exempt /openclaw-direct/*, at this gate or at Caddy\'s', () => {
      // TangleClaw injects the gateway token on this proxy, so "the gateway
      // enforces its own auth" is satisfied BY TANGLECLAW for whoever asked.
      // The old Caddy exemption existed for the Basic prompt loop (#472), and it
      // left in the same change that made Caddy's gate state-driven.
      for (const p of ['/openclaw-direct/x', '/openclaw-direct/abc/chat?session=main',
        '//openclaw-direct/x', '/openclaw-direct//x', '/x/../openclaw-direct/y',
        '/openclaw-direct%2Fx', '/%6Fpenclaw-direct/x']) {
        assert.equal(authGate.isGateBypassPath(p), false, `${p} must not be exempt at the gate`);
        assert.equal(caddy.isCaddyAuthBypassPath(p), false, `${p} must not be exempt at Caddy`);
      }
    });

    it('matches on the canonical path, so every spelling of an exempt path is exempt', () => {
      for (const p of ['//api/health', '/api//health', '/x/../manifest.json', '/%6Danifest.json', '/api/health?x=1']) {
        assert.equal(authGate.isGateBypassPath(p), true, p);
      }
    });

    it('is exact — no prefix, no case folding, no trailing slash', () => {
      for (const p of ['/', '/api/config', '/api/health/x', '/api/healthz', '/API/HEALTH',
        '/manifest.json/', '/terminal/ws', '/openclaw/p/x', '/login']) {
        assert.equal(authGate.isGateBypassPath(p), false, p);
        assert.equal(caddy.isCaddyAuthBypassPath(p), false, `Caddy agrees on ${p}`);
      }
    });
  });

  describe('guardsTheDoor — whether TangleClaw\'s gate needs nothing in front of it (#1420)', () => {
    it('is true only for armed and locked', () => {
      assert.equal(authGate.guardsTheDoor(S.ARMED), true);
      assert.equal(authGate.guardsTheDoor(S.LOCKED), true);
    });

    it('is false for every other state, and for anything that is not a state', () => {
      // account-required: whoever reaches the first-account screen claims the
      // install. unreadable: a failed read must never remove a gate.
      for (const v of [S.OPEN, S.ACCOUNT_REQUIRED, S.UNREADABLE, 'fallback', 'ARMED', '', null, undefined, true, {}]) {
        assert.equal(authGate.guardsTheDoor(v), false, JSON.stringify(v));
      }
    });
  });

  describe('evaluate', () => {
    const base = {
      method: 'GET', rawUrl: '/', pathname: '/',
      gateState: S.ARMED, session: null, submittedCsrf: null,
      // Off unless a case asks for it: the default subject of these cases is a
      // browser, and leaving it on would wave every one of them through.
      machineClient: false
    };
    const ev = (over) => authGate.evaluate({ ...base, ...over });
    const SESSION = { csrfToken: 'tok', username: 'rosie' };

    it('allows everything when the gate is open', () => {
      assert.deepEqual(ev({ gateState: S.OPEN }), { action: 'allow' });
      assert.deepEqual(
        ev({ gateState: S.OPEN, method: 'POST', pathname: '/api/config' }),
        { action: 'allow' }
      );
    });

    it('allows everything in fallback — Caddy\'s gate is the one asking (#1420)', () => {
      assert.deepEqual(ev({ gateState: S.FALLBACK }), { action: 'allow' });
      assert.deepEqual(
        ev({ gateState: S.FALLBACK, method: 'POST', pathname: '/api/config', session: SESSION }),
        { action: 'allow' }
      );
    });

    it('enforces in every state that is not exactly open or fallback, including an unknown one', () => {
      for (const gateState of [S.ARMED, S.ACCOUNT_REQUIRED, S.LOCKED, S.UNREADABLE, undefined, 'bogus', 'FALLBACK']) {
        assert.equal(ev({ gateState }).action, 'challenge', `${gateState} must enforce`);
      }
    });

    it('challenges an unauthenticated page request with the login document', () => {
      assert.deepEqual(ev({}), { action: 'challenge', as: 'html', for: 'sign-in' });
    });

    it('challenges an unauthenticated API request with JSON', () => {
      assert.deepEqual(
        ev({ rawUrl: '/api/config', pathname: '/api/config' }),
        { action: 'challenge', as: 'json', for: 'sign-in' }
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

    it('exempts a path only when the router serves that same path', () => {
      // `//login` is `/login` to the canonicaliser and `/` to `new URL`, which
      // is how the parsed `pathname` arrives. Exempting on the canonical path
      // alone served the dashboard shell to a request with no session.
      for (const [rawUrl, pathname] of [['//login', '/'], ['//manifest.json', '/'],
        ['//api/health', '/health'], ['/api/auth/%6Cogin', '/api/auth/%6Cogin']]) {
        assert.deepEqual(ev({ rawUrl, pathname }).action, 'challenge', `${rawUrl} → ${pathname}`);
      }
      assert.deepEqual(ev({ gateState: S.ACCOUNT_REQUIRED, method: 'POST',
        rawUrl: '//api/auth/set-password', pathname: '/auth/set-password' }).action, 'challenge');
      for (const [rawUrl, pathname] of [['/login?next=/', '/login'], ['/x/../login', '/login'],
        ['/api/health#x', '/api/health']]) {
        assert.deepEqual(ev({ rawUrl, pathname }), { action: 'allow' }, rawUrl);
      }
    });

    it('gates /openclaw-direct/* — it is not a bypass path (#1419, #1420)', () => {
      const p = '/openclaw-direct/abc/chat';
      assert.deepEqual(ev({ rawUrl: p, pathname: p }), { action: 'challenge', as: 'html', for: 'sign-in' });
      assert.deepEqual(ev({ rawUrl: p, pathname: p, session: SESSION }), { action: 'allow' });
    });

    it('gates the proxy prefixes, which are not routes', () => {
      // `/terminal/*` proxies to a writable ttyd — that socket is a shell — and
      // `/openclaw/*` carries the operator's gateway token. Neither is a route,
      // so both are gated only by the gate standing ahead of every branch.
      for (const p of ['/terminal/x', '/openclaw/proj/api', '/plans/p/f.md']) {
        assert.deepEqual(ev({ rawUrl: p, pathname: p }), { action: 'challenge', as: 'html', for: 'sign-in' },
          `${p} must be gated`);
      }
    });

    describe('the recovery page and route — exempt only while armed (#1420)', () => {
      it('allows a signed-out request to both in armed', () => {
        assert.deepEqual(ev({ rawUrl: '/recover', pathname: '/recover' }), { action: 'allow' });
        assert.deepEqual(ev({ method: 'POST', rawUrl: '/api/auth/recover', pathname: '/api/auth/recover' }),
          { action: 'allow' });
      });

      // Not `fallback`: there TangleClaw stands down entirely and the route itself
      // refuses with GATE_FALLBACK (`test/api-gate-fallback.test.js`).
      for (const gateState of [S.ACCOUNT_REQUIRED, S.LOCKED, S.UNREADABLE, 'FALLBACK', undefined]) {
        it(`challenges them in ${String(gateState)} — no code can succeed there`, () => {
          assert.equal(ev({ gateState, rawUrl: '/recover', pathname: '/recover' }).action, 'challenge');
          assert.equal(ev({ gateState, method: 'POST', rawUrl: '/api/auth/recover',
            pathname: '/api/auth/recover' }).action, 'challenge');
        });
      }

      it('does not exempt a spelling the router serves as a different path', () => {
        assert.equal(ev({ rawUrl: '//recover', pathname: '/' }).action, 'challenge');
      });

      it('lets a browser that still holds a session submit a code without a CSRF token', () => {
        assert.deepEqual(ev({ method: 'POST', rawUrl: '/api/auth/recover', pathname: '/api/auth/recover',
          session: SESSION, submittedCsrf: null }), { action: 'allow' });
      });
    });

    describe('account-required — no account exists yet', () => {
      const AR = { gateState: S.ACCOUNT_REQUIRED };

      it('challenges a page with the account-setup document, not the login form', () => {
        assert.deepEqual(ev(AR), { action: 'challenge', as: 'html', for: 'account-setup' });
      });

      it('challenges an API call with JSON that says an account is needed', () => {
        assert.deepEqual(ev({ ...AR, rawUrl: '/api/config', pathname: '/api/config' }),
          { action: 'challenge', as: 'json', for: 'account-setup' });
      });

      it('lets the first-account route through, on every spelling of it', () => {
        for (const rawUrl of ['/api/auth/set-password', '//api/auth/set-password']) {
          assert.deepEqual(
            ev({ ...AR, method: 'POST', rawUrl, pathname: '/api/auth/set-password' }),
            { action: 'allow' }, rawUrl);
        }
      });

      it('does NOT let the first-account route through in any other enforcing state', () => {
        // Once an account exists the route has nothing to do, and an exemption
        // that outlives its purpose is a hole for a future edit to the route.
        for (const gateState of [S.ARMED, S.LOCKED, S.UNREADABLE]) {
          assert.deepEqual(
            ev({ gateState, method: 'POST', rawUrl: '/api/auth/set-password', pathname: '/api/auth/set-password' }),
            { action: 'challenge', as: 'json', for: 'sign-in' }, gateState);
        }
      });

      it('still lets the fleet and the bypass paths through', () => {
        assert.deepEqual(ev({ ...AR, rawUrl: '/api/ports', pathname: '/api/ports', machineClient: true }),
          { action: 'allow' });
        assert.deepEqual(ev({ ...AR, rawUrl: '/api/health', pathname: '/api/health' }), { action: 'allow' });
      });

      it('still gates the shell and the gateway proxies', () => {
        for (const p of ['/terminal/x', '/openclaw/proj/api', '/openclaw-direct/abc/chat']) {
          assert.equal(ev({ ...AR, rawUrl: p, pathname: p }).action, 'challenge', p);
        }
      });

      it('lets the fleet through an UNREADABLE gate — a store fault must not take bin/tc down with it', () => {
        assert.deepEqual(ev({ gateState: S.UNREADABLE, rawUrl: '/api/ports', pathname: '/api/ports', machineClient: true }),
          { action: 'allow' });
        assert.equal(ev({ gateState: S.UNREADABLE, rawUrl: '/api/ports', pathname: '/api/ports' }).action, 'challenge');
      });

      it('shows a LOCKED install the sign-in challenge, never the account page', () => {
        assert.deepEqual(ev({ gateState: S.LOCKED }), { action: 'challenge', as: 'html', for: 'sign-in' });
      });
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
          { action: 'challenge', as: 'json', for: 'sign-in' }
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
        assert.deepEqual([...authGate.CSRF_EXEMPT_PATHS], ['/api/auth/login', '/api/auth/recover']);
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

  describe('evaluateUpgrade — the WebSocket handshake (#1419)', () => {
    const base = { gateState: S.ARMED, session: null, machineClient: false };
    const ev = (over) => authGate.evaluateUpgrade({ ...base, ...over });
    const SESSION = { csrfToken: 'tok', username: 'rosie' };

    it('allows every upgrade when the gate is open or in fallback', () => {
      assert.deepEqual(ev({ gateState: S.OPEN }), { action: 'allow' });
      assert.deepEqual(ev({ gateState: S.FALLBACK }), { action: 'allow' });
    });

    it('refuses a sessionless upgrade in every enforcing state — only the fleet gets a socket', () => {
      for (const gateState of [S.ACCOUNT_REQUIRED, S.LOCKED, S.UNREADABLE]) {
        assert.deepEqual(ev({ gateState }), { action: 'refuse' }, gateState);
        assert.deepEqual(ev({ gateState, machineClient: true }), { action: 'allow' }, gateState);
      }
    });

    it('refuses an upgrade with no session', () => {
      // `/terminal/*` proxies to a --writable ttyd: that socket is a shell.
      assert.deepEqual(ev({}), { action: 'refuse' });
    });

    it('allows an upgrade that carries a live session', () => {
      assert.deepEqual(ev({ session: SESSION }), { action: 'allow' });
    });

    it('allows the fleet by the same carve-out HTTP uses', () => {
      assert.deepEqual(ev({ machineClient: true }), { action: 'allow' });
    });

    it('takes no path — so no HTTP exemption list can ever open a shell socket', () => {
      // `evaluate` carries the bypass list and the login surface; neither is a
      // WebSocket route. Asserted on the signature, because a path argument is
      // what would let a future list addition reach the upgrade verdict.
      for (const rawUrl of ['/api/health', '/manifest.json', '/login', '/openclaw-direct/x']) {
        assert.deepEqual(ev({ rawUrl, pathname: rawUrl }), { action: 'refuse' }, rawUrl);
      }
    });

    it('opens only on a gateState that is exactly open or fallback', () => {
      // A verdict computed from a thrown or absent value must not open.
      for (const gateState of [undefined, null, '', 'OPEN', 'FALLBACK', true]) {
        assert.deepEqual(ev({ gateState }), { action: 'refuse' }, String(gateState));
      }
    });
  });
});

describe('the carve-out\'s proxy premise — what the generated Caddyfile must never say (#1420)', () => {
  // `isMachineClient` treats "no X-Forwarded-For" as "not forwarded by Caddy".
  // That holds only while Caddy sets the header on every forwarded request and
  // refuses a client's value, which it does by default and stops doing the
  // moment a `trusted_proxies` directive names the client's range, or a
  // `header_up` removes or rewrites the header. Any of those in a generated file
  // would let an off-box caller arrive looking local. This pins the generator in
  // every shape it emits; a hand-edited live file is read by the drift check.
  const BCRYPT = '$2a$14$abcdefghijklmnopqrstuv0123456789ABCDEFGHIJKLMNOPQRSTU';
  const base = { serverPort: 3102, certPath: '/tmp/cert.pem', keyPath: '/tmp/key.pem' };
  const gated = { basicAuthUser: 'jason', basicAuthHash: BCRYPT };
  const SHAPES = {
    'ungated local': base,
    gated: { ...base, ...gated },
    'gated + remote http catch-all': { ...base, ...gated, remoteHttpCatchAll: true },
    'gated + tailnet host': { ...base, ...gated, tailnetHost: 'box.tail0000.ts.net' },
    'gated + public domain': { ...base, ...gated, publicDomain: 'tc.example.com' },
    'gated + access log': { ...base, ...gated, accessLogPath: '/tmp/caddy.access.log' },
    // TangleClaw's gate guarding the door: no `basic_auth`, every remote shape.
    'armed + every remote shape': {
      ...base, ...gated, gateState: 'armed', remoteHttpCatchAll: true,
      tailnetHost: 'box.tail0000.ts.net', publicDomain: 'tc.example.com', lanHost: 'studio.local'
    }
  };

  for (const [name, opts] of Object.entries(SHAPES)) {
    it(`emits no trusted_proxies and never touches X-Forwarded-For — ${name}`, () => {
      const content = caddy.buildCaddyfileContent(opts);
      assert.ok(content.includes('reverse_proxy'), 'premise: the shape reaches the upstream');
      assert.doesNotMatch(content, /trusted_proxies/i);
      assert.doesNotMatch(content, /X-Forwarded-For/i);
    });
  }
});
