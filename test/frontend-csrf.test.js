'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const loadApiHelperGlobals = require('./_api-helper-globals');
const authSession = require('../lib/auth-session');

// The dashboard's half of the CSRF contract (#1418).
//
// RUN, not grepped. A source probe once proved a branch existed while the real
// `api()` made it unreachable (#928 R-1), and this is exactly that shape: a
// header added in one helper that every write in the product depends on.

/**
 * Load the helper with a `document.cookie` value in place.
 * @param {string|undefined} cookie - What document.cookie reads back, or undefined for no document
 * @returns {object} The sandbox
 */
function loadWithCookie(cookie) {
  const sandbox = loadApiHelperGlobals();
  if (cookie !== undefined) sandbox.document = { cookie };
  return sandbox;
}

describe('frontend CSRF plumbing (#1418)', () => {
  // The two realms agree on two names — the cookie and the header — and the
  // browser half necessarily re-spells both as literals, because `public/` may
  // not require `lib/` (this repo's rule about what an import DRAGS: store.js
  // pulls node:sqlite at module scope).
  //
  // So the agreement is pinned HERE, in the one place that can see both sides:
  // this file runs under node, so it can require the server's constants and
  // compare them against what the browser code actually produces and reads.
  // Without it, renaming `CSRF_COOKIE` or `CSRF_HEADER` in `lib/auth-session.js`
  // leaves the whole suite green while every dashboard write on a gated install
  // 403s — visible only on a live armed install, which is the operator's phone.
  //
  // The fixtures below are built from the SERVER's producers for the same
  // reason (`serializeCsrfCookie` rather than a hand-written `tc_csrf=tok`):
  // a cross-realm fixture must come from the other side's producer, not from a
  // string both sides happen to agree on today.
  describe('the two realms agree on the names, and neither side is asked to remember', () => {
    it('the browser reads exactly the cookie the server sets', () => {
      const setCookie = authSession.serializeCsrfCookie('server-minted', { secure: false });
      const jar = setCookie.split(';')[0];
      const { tcCsrfToken } = loadWithCookie(jar);
      assert.equal(tcCsrfToken(), 'server-minted',
        `the browser could not read the cookie the server produced: ${setCookie}`);
    });

    it('the browser emits exactly the header the server reads', () => {
      const { tcWithCsrf } = loadWithCookie('tc_csrf=tok');
      const emitted = Object.keys(tcWithCsrf({ method: 'POST' }).headers);
      const lowered = emitted.map((h) => h.toLowerCase());
      assert.ok(lowered.includes(authSession.CSRF_HEADER),
        `browser emits ${JSON.stringify(emitted)}, server reads '${authSession.CSRF_HEADER}'`);
    });

    it('and the server would actually accept what the browser sent', () => {
      // End to end across the seam, through both real functions: mint, set,
      // read in the browser, emit, then read back the way `handleRequest` does.
      const minted = 'a-minted-token';
      const jar = authSession.serializeCsrfCookie(minted, { secure: false }).split(';')[0];
      const { tcWithCsrf } = loadWithCookie(jar);
      const headers = {};
      for (const [k, v] of Object.entries(tcWithCsrf({ method: 'POST' }).headers)) {
        headers[k.toLowerCase()] = v;
      }
      const submitted = authSession.csrfTokenFromRequest({ headers });
      assert.equal(authSession.csrfTokenMatches(submitted, minted), true);
    });
  });

  describe('tcCsrfToken', () => {
    it('reads the token out of document.cookie', () => {
      const { tcCsrfToken } = loadWithCookie('a=1; tc_csrf=abc123; b=2');
      assert.equal(tcCsrfToken(), 'abc123');
    });

    it('url-decodes it', () => {
      const { tcCsrfToken } = loadWithCookie('tc_csrf=a%20b');
      assert.equal(tcCsrfToken(), 'a b');
    });

    it('returns null with no cookie, an empty jar, or another cookie only', () => {
      assert.equal(loadWithCookie('').tcCsrfToken(), null);
      assert.equal(loadWithCookie('other=1').tcCsrfToken(), null);
      assert.equal(loadWithCookie('tc_csrf=').tcCsrfToken(), null);
    });

    it('does NOT match a cookie whose name merely ends in tc_csrf', () => {
      // `nottc_csrf=` must not be read as ours.
      assert.equal(loadWithCookie('nottc_csrf=abc').tcCsrfToken(), null);
    });

    it('returns null where there is no document at all', () => {
      // This file loads outside a browser — the suite lifts it into a VM
      // sandbox and its IIFE falls back to globalThis. Reading `document`
      // unguarded turned every api() call in those contexts into a
      // ReferenceError reported as the server's error message.
      const { tcCsrfToken } = loadWithCookie(undefined);
      assert.equal(tcCsrfToken(), null);
    });
  });

  describe('tcWithCsrf', () => {
    const withToken = () => loadWithCookie('tc_csrf=tok').tcWithCsrf;

    it('adds the header to every state-changing method', () => {
      const f = withToken();
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        assert.equal(f({ method }).headers['X-CSRF-Token'], 'tok', `${method} must carry it`);
      }
    });

    it('matches the method case-insensitively', () => {
      assert.equal(withToken()({ method: 'post' }).headers['X-CSRF-Token'], 'tok');
    });

    it('leaves a GET untouched', () => {
      const f = withToken();
      const opts = { method: 'GET' };
      assert.equal(f(opts), opts, 'the very same object, not a copy');
      assert.equal(f(undefined), undefined, 'a bare fetch with no options stays bare');
    });

    it('leaves a write untouched when there is no session', () => {
      // An ungated install, and the login POST itself. The header is simply
      // absent, which is what both need.
      const f = loadWithCookie('').tcWithCsrf;
      const opts = { method: 'POST' };
      assert.equal(f(opts), opts);
    });

    it('preserves the caller\'s other options and headers', () => {
      const f = withToken();
      const out = f({ method: 'POST', body: '{"a":1}', headers: { 'Content-Type': 'application/json' } });
      assert.equal(out.body, '{"a":1}');
      assert.equal(out.headers['Content-Type'], 'application/json');
      assert.equal(out.headers['X-CSRF-Token'], 'tok');
    });

    it('does not mutate the object it was given', () => {
      // The caller may reuse it; silently adding a header to a shared options
      // object is the kind of action-at-a-distance that surfaces much later.
      const f = withToken();
      const opts = { method: 'POST', headers: { 'Content-Type': 'application/json' } };
      f(opts);
      assert.equal(opts.headers['X-CSRF-Token'], undefined);
    });
  });

  describe('api() sends it — the wiring, not just the helper', () => {
    /**
     * Build a sandbox whose fetch records what it was called with.
     * @param {string} cookie
     * @returns {{ sandbox: object, calls: Array }}
     */
    function withRecordingFetch(cookie) {
      const sandbox = loadWithCookie(cookie);
      const calls = [];
      sandbox.fetch = async (url, opts) => {
        calls.push({ url, opts });
        return {
          ok: true,
          status: 200,
          headers: { get: () => null },
          json: async () => ({ ok: true })
        };
      };
      return { sandbox, calls };
    }

    it('attaches the header to a mutating call made through api()', () => {
      const { sandbox, calls } = withRecordingFetch('tc_csrf=tok');
      const api = sandbox.tcCreateApi();
      return api('/api/config', { method: 'PATCH', body: '{}' }).then(() => {
        assert.equal(calls[0].opts.headers['X-CSRF-Token'], 'tok');
      });
    });

    it('attaches it to a BODYLESS write too', () => {
      // The dashboard sends genuine bodyless writes (`medusa/toggle`,
      // `medusa/read`, `wrap-sentinel/ack`) that do not go via apiMutate. A
      // per-call-site header would be a rule to remember on every future
      // write, and the one that got forgotten would fail only on a gated
      // install.
      const { sandbox, calls } = withRecordingFetch('tc_csrf=tok');
      const api = sandbox.tcCreateApi();
      return api('/api/sessions/x/medusa/toggle', { method: 'POST' }).then(() => {
        assert.equal(calls[0].opts.headers['X-CSRF-Token'], 'tok');
      });
    });

    it('attaches it to an apiMutate call', () => {
      const { sandbox, calls } = withRecordingFetch('tc_csrf=tok');
      const api = sandbox.tcCreateApi();
      const apiMutate = sandbox.tcCreateApiMutate(api);
      return apiMutate('/api/config', 'PATCH', { a: 1 }).then(() => {
        assert.equal(calls[0].opts.headers['X-CSRF-Token'], 'tok');
        assert.equal(calls[0].opts.headers['Content-Type'], 'application/json',
          'and does not displace the type apiMutate sets');
      });
    });

    it('does not attach it to a GET', () => {
      const { sandbox, calls } = withRecordingFetch('tc_csrf=tok');
      const api = sandbox.tcCreateApi();
      return api('/api/config').then(() => {
        assert.ok(!calls[0].opts || !calls[0].opts.headers,
          'a plain GET must reach fetch exactly as the caller wrote it');
      });
    });
  });
});
