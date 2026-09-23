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
        assert.equal(calls[0].opts.headers['X-TangleClaw-Client'], 'dashboard',
          'a write carries the dashboard label too (#1753)');
      });
    });

    it('labels a request without mutating the options the caller passed', () => {
      const { sandbox, calls } = withRecordingFetch('tc_csrf=tok');
      const api = sandbox.tcCreateApi();
      const opts = { headers: { Accept: 'application/json' } };
      return api('/api/projects', opts).then(() => {
        assert.equal(calls[0].opts.headers['X-TangleClaw-Client'], 'dashboard');
        assert.equal(calls[0].opts.headers.Accept, 'application/json');
        assert.deepEqual(Object.keys(opts.headers), ['Accept'], 'the caller\'s object is unchanged');
      });
    });

    it('does not attach it to a GET', () => {
      const { sandbox, calls } = withRecordingFetch('tc_csrf=tok');
      const api = sandbox.tcCreateApi();
      return api('/api/config').then(() => {
        // The token stays off a GET. The one header a GET does carry is the
        // dashboard label (#1753), which is not a credential.
        const headers = (calls[0].opts && calls[0].opts.headers) || {};
        assert.equal(headers['X-CSRF-Token'], undefined, 'a GET must not carry the CSRF token');
        assert.deepEqual(Object.keys(headers), ['X-TangleClaw-Client'],
          'a plain GET carries nothing but the dashboard label');
      });
    });
  });

  describe('tcFetch — the raw-Response path carries the token too (#1462)', () => {
    it('attaches the header to a write and hands back the response unread', async () => {
      const sandbox = loadWithCookie('tc_csrf=tok');
      const calls = [];
      const response = { ok: true, status: 204, headers: { get: () => null } };
      sandbox.fetch = async (url, opts) => { calls.push({ url, opts }); return response; };
      const res = await sandbox.tcFetch('/api/dashboard/boot', { method: 'POST', body: '{}' });
      assert.equal(calls[0].opts.headers['X-CSRF-Token'], 'tok');
      assert.equal(calls[0].url, '/api/dashboard/boot',
        'the URL reaches fetch untouched — a relative launch URL is what lets the server read the operator\'s Host');
      assert.equal(res, response, 'the caller gets the very response fetch produced');
    });

    it('rejects exactly as fetch does, so a caller\'s network-failure branch still runs', async () => {
      const sandbox = loadWithCookie('tc_csrf=tok');
      sandbox.fetch = async () => { throw new TypeError('Failed to fetch'); };
      await assert.rejects(sandbox.tcFetch('/api/x', { method: 'DELETE' }), TypeError);
    });
  });

  describe('a page whose session ended leaves for /login on the first 401', () => {
    /**
     * A sandbox with a recording `location` and a fetch that answers `reply`.
     * @param {object} reply
     * @param {number} reply.status
     * @param {string|null} [reply.type] - content-type, null for none
     * @param {*} [reply.body] - What `json()` resolves to; a function throws
     * @param {string} [pathname] - The page the request is made from
     * @returns {{ sandbox: object, visits: string[], reads: object }}
     */
    function pageAnswering(reply, pathname = '/') {
      const sandbox = loadWithCookie('tc_csrf=tok');
      const visits = [];
      const reads = { original: 0, clone: 0 };
      sandbox.location = { pathname, replace: (to) => visits.push(to) };
      const json = async () => {
        if (typeof reply.body === 'function') return reply.body();
        return reply.body;
      };
      sandbox.fetch = async () => ({
        ok: reply.status < 400,
        status: reply.status,
        headers: { get: (h) => (h.toLowerCase() === 'content-type' ? (reply.type === undefined ? 'application/json' : reply.type) : null) },
        json: async () => { reads.original += 1; return json(); },
        clone: () => ({ json: async () => { reads.clone += 1; return json(); } })
      });
      return { sandbox, visits, reads };
    }

    for (const code of ['UNAUTHENTICATED', 'ACCOUNT_REQUIRED']) {
      it(`goes to /login on a 401 ${code}`, async () => {
        const { sandbox, visits } = pageAnswering({ status: 401, body: { error: 'Sign in', code } });
        await sandbox.tcFetch('/api/uploads', { method: 'POST' });
        assert.deepEqual(visits, ['/login']);
      });
    }

    it('the codes are the ones the gate actually sends for a missing session', () => {
      // Read from the server, so renaming a code there cannot leave the page
      // listening for a word nobody says.
      const serverSrc = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'server.js'), 'utf8');
      for (const code of ['UNAUTHENTICATED', 'ACCOUNT_REQUIRED']) {
        assert.ok(new RegExp(`errorResponse\\(res, 401,[\\s\\S]{0,120}'${code}'`).test(serverSrc),
          `server.js no longer answers 401 ${code}; the redirect listens for it`);
      }
    });

    for (const code of ['INVALID_CREDENTIALS', 'INVALID_RECOVERY_CODE', 'UNAUTHORIZED']) {
      it(`stays put on a 401 ${code} — a wrong credential is not an ended session`, async () => {
        const { sandbox, visits } = pageAnswering({ status: 401, body: { error: 'no', code } });
        await sandbox.tcFetch('/api/auth/recovery-codes', { method: 'POST' });
        assert.deepEqual(visits, []);
      });
    }

    it('stays put on a non-JSON 401 — that is Caddy\'s challenge, the browser\'s to answer', async () => {
      // The body would name a session code if it were read: only the type check
      // can be what keeps the page in place.
      const { sandbox, visits } = pageAnswering({ status: 401, type: 'text/html', body: { code: 'UNAUTHENTICATED' } });
      await sandbox.tcFetch('/api/projects');
      assert.deepEqual(visits, []);
    });

    it('stays put on a JSON body that will not parse', async () => {
      const { sandbox, visits } = pageAnswering({ status: 401, body: () => { throw new SyntaxError('bad'); } });
      await sandbox.tcFetch('/api/projects');
      assert.deepEqual(visits, []);
    });

    it('stays put on a 403 UNAUTHENTICATED-looking body — only a 401 is a missing session', async () => {
      const { sandbox, visits } = pageAnswering({ status: 403, body: { code: 'UNAUTHENTICATED' } });
      await sandbox.tcFetch('/api/projects');
      assert.deepEqual(visits, []);
    });

    it('does not navigate from /login itself', async () => {
      const { sandbox, visits } = pageAnswering({ status: 401, body: { code: 'UNAUTHENTICATED' } }, '/login');
      await sandbox.tcFetch('/api/auth/me');
      assert.deepEqual(visits, []);
    });

    it('navigates ONCE however many requests come back refused', async () => {
      const { sandbox, visits } = pageAnswering({ status: 401, body: { code: 'UNAUTHENTICATED' } });
      await Promise.all([sandbox.tcFetch('/api/a'), sandbox.tcFetch('/api/b'), sandbox.tcFetch('/api/c')]);
      await sandbox.tcFetch('/api/d');
      assert.deepEqual(visits, ['/login']);
    });

    it('reads the code from a clone, leaving the caller\'s body unread', async () => {
      const { sandbox, reads } = pageAnswering({ status: 401, body: { code: 'UNAUTHENTICATED' } });
      await sandbox.tcFetch('/api/a', { method: 'DELETE' });
      assert.equal(reads.original, 0, 'the caller must still be able to read the response');
      assert.equal(reads.clone, 1);
    });

    it('api() polls leave too — the path every dashboard poll takes', async () => {
      const { sandbox, visits } = pageAnswering({ status: 401, body: { error: 'Sign in to continue.', code: 'UNAUTHENTICATED' } });
      const api = sandbox.tcCreateApi();
      assert.equal(await api('/api/projects'), null, 'api() keeps its null-on-refusal contract');
      assert.equal(api.lastErrorCode, 'UNAUTHENTICATED');
      assert.deepEqual(visits, ['/login']);
    });
  });

  describe('every browser write in public/ goes through tcFetch or api() — the family, not #1462', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const authGate = require('../lib/auth-gate');
    const PUBLIC = path.join(__dirname, '..', 'public');

    // Pages that post before any session exists, so there is no token to send
    // and nothing to leave for: the sign-in form, the recovery-code form and the
    // first-account form. A 401 on them is the form's own answer.
    const PRE_SESSION_PAGES = new Set(['login.html', 'recover.html', 'account-setup.html']);

    /**
     * Every bare `fetch(...)` call in a source text, with its argument text.
     * `tcFetch(` does not match (capital F), nor does a `.fetch(` method.
     * @param {string} src
     * @returns {Array<{ line: number, args: string }>}
     */
    function bareFetchCalls(src) {
      const out = [];
      const re = /(^|[^\w.$])fetch\(/g;
      let m;
      while ((m = re.exec(src))) {
        const start = m.index + m[0].length;
        let depth = 1;
        let i = start;
        for (; i < src.length && depth > 0; i++) {
          if (src[i] === '(') depth += 1;
          else if (src[i] === ')') depth -= 1;
        }
        out.push({ line: src.slice(0, m.index).split('\n').length, args: src.slice(start, i - 1) });
      }
      return out;
    }

    /**
     * Whether a call's options name a method the gate CSRF-checks. A method the
     * scan cannot read as a literal counts as unsafe: it may be one.
     * @param {string} args
     * @returns {boolean}
     */
    function writes(args) {
      // The token helper applied in place is the one bare fetch that is safe
      // whatever its method: it is `tcFetch` itself.
      if (/\btcWithCsrf\(/.test(args)) return false;
      const named = args.match(/method\s*:\s*(['"`])(\w+)\1/);
      if (named) return authGate.UNSAFE_METHODS.has(named[2].toUpperCase());
      if (/\bmethod\b/.test(args)) return true;
      // No method written in the call. An object literal (or nothing) as the
      // options means GET; options built elsewhere may carry any method.
      const options = secondArgument(args);
      return options !== null && !/^\{/.test(options);
    }

    /**
     * The text of a call's second top-level argument, or null when it has one.
     * @param {string} args
     * @returns {string|null}
     */
    function secondArgument(args) {
      let depth = 0;
      for (let i = 0; i < args.length; i++) {
        const ch = args[i];
        if ('([{'.includes(ch)) depth += 1;
        else if (')]}'.includes(ch)) depth -= 1;
        else if (ch === ',' && depth === 0) {
          const rest = args.slice(i + 1).trim();
          return rest ? rest : null;
        }
      }
      return null;
    }

    /**
     * Every .js and .html file under a directory, recursively.
     * @param {string} dir
     * @returns {string[]} Paths relative to `dir`
     */
    function pageSources(dir) {
      const out = [];
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          for (const inner of pageSources(path.join(dir, entry.name))) out.push(path.join(entry.name, inner));
        } else if (/\.(js|html)$/.test(entry.name)) {
          out.push(entry.name);
        }
      }
      return out;
    }

    it('the browser\'s unsafe-method list is the gate\'s', () => {
      const src = fs.readFileSync(path.join(PUBLIC, 'api-helper.js'), 'utf8');
      const listed = JSON.parse(src.match(/const TC_UNSAFE_METHODS = (\[[^\]]*\])/)[1].replace(/'/g, '"'));
      assert.deepEqual([...listed].sort(), [...authGate.UNSAFE_METHODS].sort());
    });

    it('the scan sees a bare write — it would fail on one', () => {
      const found = bareFetchCalls("x(); await fetch('/api/a', {\n method: 'DELETE' }); tcFetch('/b', { method: 'POST' });");
      assert.equal(found.length, 1, 'tcFetch( is not a bare fetch');
      assert.equal(writes(found[0].args), true);
      assert.equal(writes(bareFetchCalls("fetch('/api/a', { cache: 'no-store' })")[0].args), false);
      assert.equal(writes(bareFetchCalls('fetch(u, { method })')[0].args), true, 'an unreadable method is unsafe');
      assert.equal(writes(bareFetchCalls('fetch(u, opts)')[0].args), true, 'options built elsewhere may be a write');
      assert.equal(writes(bareFetchCalls('fetch(buildUrl(a, b))')[0].args), false, 'a comma inside the URL is not options');
      assert.equal(writes(bareFetchCalls('fetch(event.request)')[0].args), false);
      assert.equal(writes(bareFetchCalls('fetch(url, tcWithCsrf(fetchOpts))')[0].args), false, 'tcFetch itself');
    });

    it('and the pre-session pages really do post bare — the exemption is live, not a leftover', () => {
      for (const page of PRE_SESSION_PAGES) {
        const src = fs.readFileSync(path.join(PUBLIC, page), 'utf8');
        assert.ok(bareFetchCalls(src).some((c) => writes(c.args)),
          `${page} no longer posts with a bare fetch; drop it from PRE_SESSION_PAGES`);
      }
    });

    it('no other page sends a write with a bare fetch', () => {
      const offenders = [];
      for (const name of pageSources(PUBLIC)) {
        if (PRE_SESSION_PAGES.has(name)) continue;
        const src = fs.readFileSync(path.join(PUBLIC, name), 'utf8');
        for (const call of bareFetchCalls(src)) {
          if (writes(call.args)) offenders.push(`public/${name}:${call.line}`);
        }
      }
      assert.deepEqual(offenders, [],
        'a bare fetch with an unsafe method carries no CSRF token and the gate refuses it on every '
        + 'signed-in install; use tcFetch (raw Response) or api()');
    });

    it('and no dashboard or session request of ANY method calls fetch directly', () => {
      // A GET needs no token, but it does need to leave for /login when the
      // session is gone: a plain-fetch poll fails in place, and behind a live
      // basic_auth it is what feeds the prompt loop. So the rule is every
      // request, not every write. Named exemptions, each with its reason:
      const EXEMPT = new Map([
        // Posts and reads that run before a session exists.
        ...[...PRE_SESSION_PAGES].map((p) => [p, 'pre-session page']),
        // The first-run wizard's reads: no session exists yet, and it runs
        // when no account may exist, where /login is not where it should go.
        ['setup.js', 'first-run wizard'],
        // The service worker forwards the page's own requests; it originates none.
        ['sw.js', 'forwards requests']
      ]);
      const offenders = [];
      for (const name of pageSources(PUBLIC)) {
        if (EXEMPT.has(name)) continue;
        const src = fs.readFileSync(path.join(PUBLIC, name), 'utf8');
        for (const call of bareFetchCalls(src)) {
          // `tcFetch`'s own call, the one place fetch is reached.
          if (name === 'api-helper.js' && /^url, tcWithCsrf\(fetchOpts\)$/.test(call.args.trim())) continue;
          offenders.push(`public/${name}:${call.line}`);
        }
      }
      assert.deepEqual(offenders, [], 'use tcFetch (raw Response) or api()');
    });
  });
});
