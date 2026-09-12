'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const authSession = require('../lib/auth-session');

describe('lib/auth-session — cookie and token mechanism (#1418, ADR 0016)', () => {
  describe('mintToken', () => {
    it('returns 64 hex characters', () => {
      assert.match(authSession.mintToken(), /^[0-9a-f]{64}$/);
    });

    it('never repeats', () => {
      // Not a statistical claim — a mint that returned a constant would be the
      // whole security model gone, and this is the cheapest way to red on it.
      const seen = new Set();
      for (let i = 0; i < 200; i++) seen.add(authSession.mintToken());
      assert.equal(seen.size, 200);
    });
  });

  describe('hashToken', () => {
    it('is deterministic for the same token', () => {
      const t = authSession.mintToken();
      assert.equal(authSession.hashToken(t), authSession.hashToken(t));
    });

    it('does not contain the token it hashes', () => {
      // The property the storage design rests on: what lands in the database
      // must not be reversible to the cookie by reading it.
      const t = authSession.mintToken();
      const h = authSession.hashToken(t);
      assert.ok(!h.includes(t));
      assert.notEqual(h, t);
    });

    it('differs for two different tokens', () => {
      assert.notEqual(
        authSession.hashToken('a'.repeat(64)),
        authSession.hashToken('b'.repeat(64))
      );
    });
  });

  describe('parseCookies', () => {
    it('parses a normal header', () => {
      assert.deepEqual(
        authSession.parseCookies('a=1; b=2'),
        { a: '1', b: '2' }
      );
    });

    it('percent-decodes values', () => {
      assert.deepEqual(authSession.parseCookies('x=a%20b'), { x: 'a b' });
    });

    it('returns {} for a missing or empty header', () => {
      assert.deepEqual(authSession.parseCookies(undefined), {});
      assert.deepEqual(authSession.parseCookies(''), {});
    });

    it('skips malformed pairs instead of throwing', () => {
      // This runs on every request including unauthenticated ones. A browser
      // carrying one broken cookie from some other tool must not take the
      // server down — it should simply read as not carrying ours.
      assert.deepEqual(authSession.parseCookies('broken; =novalue; ok=1'), { ok: '1' });
    });

    it('survives invalid percent-encoding', () => {
      assert.deepEqual(authSession.parseCookies('x=%ZZ'), { x: '%ZZ' });
    });
  });

  describe('tokenFromRequest', () => {
    it('reads the session cookie', () => {
      const req = { headers: { cookie: `other=1; ${authSession.SESSION_COOKIE}=abc` } };
      assert.equal(authSession.tokenFromRequest(req), 'abc');
    });

    it('returns null with no cookie header at all', () => {
      assert.equal(authSession.tokenFromRequest({ headers: {} }), null);
    });

    it('returns null when another cookie is present but ours is not', () => {
      assert.equal(authSession.tokenFromRequest({ headers: { cookie: 'a=1' } }), null);
    });

    it('returns null for an empty value rather than an empty string', () => {
      // An empty token must not read as "present": `resolve` would hash '' and
      // a row could in principle exist for it.
      const req = { headers: { cookie: `${authSession.SESSION_COOKIE}=` } };
      assert.equal(authSession.tokenFromRequest(req), null);
    });
  });

  describe('isSecureRequest', () => {
    it('is true on a TLS socket', () => {
      assert.equal(authSession.isSecureRequest({ socket: { encrypted: true }, headers: {} }), true);
    });

    it('is true behind a proxy that reports https', () => {
      // The case that matters: in caddy ingress mode Caddy terminates TLS and
      // forwards over plain HTTP to loopback, so the socket is NOT encrypted on
      // exactly the deployment where the cookie most needs `Secure`.
      assert.equal(
        authSession.isSecureRequest({ headers: { 'x-forwarded-proto': 'https' } }),
        true
      );
    });

    it('takes the FIRST value of a chained X-Forwarded-Proto', () => {
      assert.equal(
        authSession.isSecureRequest({ headers: { 'x-forwarded-proto': 'https, http' } }),
        true
      );
      assert.equal(
        authSession.isSecureRequest({ headers: { 'x-forwarded-proto': 'http, https' } }),
        false
      );
    });

    it('is false on plain http with no proxy header', () => {
      assert.equal(authSession.isSecureRequest({ headers: {} }), false);
    });
  });

  describe('serializeCookie', () => {
    it('is always HttpOnly, Path=/ and SameSite=Lax', () => {
      const c = authSession.serializeCookie('tok', { secure: false });
      assert.match(c, /(^|; )HttpOnly(;|$)/);
      assert.match(c, /(^|; )Path=\/(;|$)/);
      assert.match(c, /(^|; )SameSite=Lax(;|$)/);
    });

    it('omits Secure on a plain-http request', () => {
      // ADR 0016's load-bearing conditional. A direct-mode install on plain
      // http over the tailnet is supported (ADR 0003), and a `Secure` cookie is
      // silently never stored there — a login that appears to succeed and then
      // does nothing.
      assert.doesNotMatch(authSession.serializeCookie('tok', { secure: false }), /Secure/);
    });

    it('sets Secure on an https request', () => {
      assert.match(authSession.serializeCookie('tok', { secure: true }), /(^|; )Secure$/);
    });

    it('carries the token, url-encoded', () => {
      assert.match(
        authSession.serializeCookie('a b', { secure: false }),
        new RegExp(`^${authSession.SESSION_COOKIE}=a%20b;`)
      );
    });

    it('expires with the session TTL by default', () => {
      const expected = Math.floor(authSession.SESSION_TTL_MS / 1000);
      assert.match(
        authSession.serializeCookie('tok', { secure: false }),
        new RegExp(`(^|; )Max-Age=${expected}(;|$)`)
      );
    });
  });

  describe('clearCookie', () => {
    // The parity invariant, DERIVED from the setter rather than enumerated.
    //
    // A browser matches a replacement cookie on name, domain and path, so a
    // clear that drops any scoping attribute leaves the real cookie in place
    // and logout silently does nothing. The first version of this check walked
    // a hardcoded list — which meant a FIFTH attribute added to a setter (a
    // `Domain`, a `SameSite=Strict`, a `__Host-` rename) was not compared at
    // all and the suite stayed green while logout stopped clearing. Reading the
    // attributes off the setter's own output makes it a check rather than a
    // list.
    const LIFETIME = /^(Max-Age|Expires)=/i;

    /**
     * Split a Set-Cookie value into its scoping attributes.
     * @param {string} c
     * @returns {string[]} every attribute except the name=value pair and the lifetime
     */
    const scopingAttrs = (c) => c.split('; ').slice(1).filter((a) => !LIFETIME.test(a));

    for (const [label, set, clear] of [
      ['session',
        (secure) => authSession.serializeCookie('tok', { secure }),
        (secure) => authSession.clearCookie({ secure })],
      ['csrf',
        (secure) => authSession.serializeCsrfCookie('tok', { secure }),
        (secure) => authSession.clearCsrfCookie({ secure })]
    ]) {
      for (const secure of [true, false]) {
        it(`the ${label} clear repeats every scoping attribute the setter emits (secure=${secure})`, () => {
          const setAttrs = scopingAttrs(set(secure));
          const clearAttrs = scopingAttrs(clear(secure));
          assert.ok(setAttrs.length > 0, 'precondition: the setter emits scoping attributes');
          assert.deepEqual(clearAttrs.sort(), setAttrs.sort(),
            `${label} clear must carry exactly the setter's scoping attributes`);
        });

        it(`the ${label} clear uses the same cookie NAME (secure=${secure})`, () => {
          assert.equal(clear(secure).split('=')[0], set(secure).split('=')[0]);
        });
      }
    }

    it('expires immediately and carries no value', () => {
      const c = authSession.clearCookie({ secure: false });
      assert.match(c, /(^|; )Max-Age=0(;|$)/);
      assert.match(c, new RegExp(`^${authSession.SESSION_COOKIE}=;`));
    });
  });

  describe('the CSRF cookie', () => {
    it('is NOT HttpOnly — the page has to read it', () => {
      assert.doesNotMatch(
        authSession.serializeCsrfCookie('tok', { secure: false }), /HttpOnly/
      );
    });

    it('still scopes and secures like the session cookie', () => {
      const c = authSession.serializeCsrfCookie('tok', { secure: true });
      assert.match(c, /(^|; )Path=\/(;|$)/);
      assert.match(c, /(^|; )SameSite=Lax(;|$)/);
      assert.match(c, /(^|; )Secure$/);
    });

    it('expires immediately', () => {
      // The attribute PARITY is checked by the derived loop in `clearCookie`
      // above, for both pairs; what is left to state here is the lifetime,
      // which is the one attribute that must deliberately NOT match.
      assert.match(authSession.clearCsrfCookie({ secure: false }), /(^|; )Max-Age=0(;|$)/);
    });

    it('is a different cookie name from the session', () => {
      assert.notEqual(authSession.CSRF_COOKIE, authSession.SESSION_COOKIE);
    });
  });

  describe('stripOwnCookies — the session must not travel to an upstream', () => {
    const { SESSION_COOKIE, CSRF_COOKIE } = authSession;

    it('removes both of ours and keeps everything else', () => {
      const got = authSession.stripOwnCookies(
        `a=1; ${SESSION_COOKIE}=secret; b=2; ${CSRF_COOKIE}=tok; c=3`);
      assert.equal(got, 'a=1; b=2; c=3');
    });

    it('never leaves the session value anywhere in the result', () => {
      const got = authSession.stripOwnCookies(`${SESSION_COOKIE}=supersecret; keep=1`);
      assert.equal(String(got).includes('supersecret'), false);
    });

    it('returns undefined when nothing survives, so the header is DROPPED', () => {
      // Not an empty string: an empty `Cookie:` header is malformed to some
      // servers, and "no cookies" is what we mean.
      assert.equal(authSession.stripOwnCookies(`${SESSION_COOKIE}=x`), undefined);
      assert.equal(authSession.stripOwnCookies(`${SESSION_COOKIE}=x; ${CSRF_COOKIE}=y`), undefined);
      assert.equal(authSession.stripOwnCookies(''), undefined);
      assert.equal(authSession.stripOwnCookies(undefined), undefined);
    });

    it('keeps a foreign cookie whose name merely CONTAINS ours', () => {
      // The gateway sets its own cookies through this proxy; stripping them
      // would break its UI while looking like a TangleClaw bug.
      const got = authSession.stripOwnCookies(`not_${SESSION_COOKIE}=x; ${SESSION_COOKIE}_extra=y`);
      assert.equal(got, `not_${SESSION_COOKIE}=x; ${SESSION_COOKIE}_extra=y`);
    });

    it('tolerates odd spacing', () => {
      assert.equal(authSession.stripOwnCookies(`  ${SESSION_COOKIE}=x ;  keep=1  `), 'keep=1');
    });
  });

  describe('stripOwnCookiesFromHeaders', () => {
    it('deletes the cookie header outright when only ours were present', () => {
      const out = authSession.stripOwnCookiesFromHeaders({
        host: 'x', cookie: `${authSession.SESSION_COOKIE}=x`
      });
      assert.equal('cookie' in out, false);
      assert.equal(out.host, 'x');
    });

    it('rewrites it when something survives', () => {
      const out = authSession.stripOwnCookiesFromHeaders({
        cookie: `keep=1; ${authSession.SESSION_COOKIE}=x`
      });
      assert.equal(out.cookie, 'keep=1');
    });

    it('does not mutate the headers it was given', () => {
      const headers = { cookie: `${authSession.SESSION_COOKIE}=x` };
      authSession.stripOwnCookiesFromHeaders(headers);
      assert.equal(headers.cookie, `${authSession.SESSION_COOKIE}=x`);
    });

    it('is a no-op for headers with no cookie at all', () => {
      const out = authSession.stripOwnCookiesFromHeaders({ host: 'x' });
      assert.deepEqual(out, { host: 'x' });
    });
  });

  describe('csrfTokenMatches', () => {
    it('accepts an exact match', () => {
      assert.equal(authSession.csrfTokenMatches('abc', 'abc'), true);
    });

    it('refuses a mismatch', () => {
      assert.equal(authSession.csrfTokenMatches('abc', 'abd'), false);
    });

    it('refuses different lengths WITHOUT throwing', () => {
      // `crypto.timingSafeEqual` throws on unequal buffer lengths — the same
      // trap `lib/password.js` documents. An exception here would be a 500 on
      // every write from a client holding a stale token.
      assert.equal(authSession.csrfTokenMatches('abc', 'abcdef'), false);
    });

    it('refuses empty and non-string values', () => {
      // Each of these would otherwise be a way to pass the check by supplying
      // nothing, which is exactly what an attacker has.
      for (const [a, b] of [
        ['', ''], ['abc', ''], ['', 'abc'],
        [null, 'abc'], ['abc', null], [undefined, undefined],
        [{}, 'abc'], [['abc'], 'abc']
      ]) {
        assert.equal(authSession.csrfTokenMatches(a, b), false,
          `${JSON.stringify(a)} vs ${JSON.stringify(b)} must not match`);
      }
    });
  });

  describe('csrfTokenFromRequest', () => {
    it('reads the header', () => {
      assert.equal(
        authSession.csrfTokenFromRequest({ headers: { [authSession.CSRF_HEADER]: 'x' } }),
        'x'
      );
    });

    it('returns null when absent or empty', () => {
      assert.equal(authSession.csrfTokenFromRequest({ headers: {} }), null);
      assert.equal(
        authSession.csrfTokenFromRequest({ headers: { [authSession.CSRF_HEADER]: '' } }),
        null
      );
    });
  });

  describe('expiryFrom', () => {
    it('adds the TTL to the supplied clock', () => {
      assert.equal(authSession.expiryFrom(1000), 1000 + authSession.SESSION_TTL_MS);
    });

    it('defaults to now', () => {
      const before = Date.now();
      const got = authSession.expiryFrom();
      assert.ok(got >= before + authSession.SESSION_TTL_MS);
    });
  });
});
