'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  matchRoute, route, parseQuery, reqUrl, handleUpgrade, handleRequest,
  _openclawProxyHeaders, _openclawWsRequestLines, _hostIsAllowed
} = require('../server');

describe('server', () => {
  describe('reqUrl', () => {
    it('parses the request URL with the Host header', () => {
      const u = reqUrl({ url: '/api/ports?host=example-host', headers: { host: 'box:3102' } });
      assert.equal(u.href, 'http://box:3102/api/ports?host=example-host');
      assert.equal(u.searchParams.get('host'), 'example-host');
    });

    it('falls back to localhost when the Host header is absent (regression: server.js:1260 drift)', () => {
      // A request with no Host header must not throw — the drifted /api/ports
      // handler used `http://${req.headers.host}` with no fallback and threw here.
      const u = reqUrl({ url: '/api/ports?host=x', headers: {} });
      assert.equal(u.host, 'localhost');
      assert.equal(u.searchParams.get('host'), 'x');
    });
  });

  describe('matchRoute', () => {
    it('should match exact paths', () => {
      const result = matchRoute('GET', '/api/health');
      assert.ok(result, 'Should match /api/health');
    });

    it('should return null for unmatched paths', () => {
      const result = matchRoute('GET', '/api/nonexistent');
      assert.equal(result, null);
    });

    it('should return null for wrong method', () => {
      const result = matchRoute('POST', '/api/health');
      assert.equal(result, null);
    });

    it('should extract params from path', () => {
      const result = matchRoute('GET', '/api/config');
      assert.ok(result);
    });
  });

  describe('parseQuery', () => {
    it('should parse simple params', () => {
      const params = parseQuery('?foo=bar&baz=qux');
      assert.equal(params.foo, 'bar');
      assert.equal(params.baz, 'qux');
    });

    it('should handle empty query', () => {
      const params = parseQuery('');
      assert.deepEqual(params, {});
    });

    it('should handle null/undefined', () => {
      const params = parseQuery(null);
      assert.deepEqual(params, {});
    });

    it('should decode URI components', () => {
      const params = parseQuery('?name=hello%20world');
      assert.equal(params.name, 'hello world');
    });
  });

  describe('handleUpgrade', () => {
    /**
     * Create a mock socket that tracks whether destroy() was called.
     * @returns {{ destroy: Function, destroyed: boolean }}
     */
    function mockSocket() {
      const { PassThrough } = require('node:stream');
      const s = new PassThrough();
      s.destroyed = false;
      const origDestroy = s.destroy.bind(s);
      s.destroy = () => { s.destroyed = true; origDestroy(); };
      return s;
    }

    /**
     * Create a mock upgrade request.
     * @param {string} url
     * @returns {object}
     */
    function mockReq(url) {
      return { url, headers: { host: 'localhost:3102', upgrade: 'websocket', connection: 'Upgrade' } };
    }

    it('should destroy socket for non-terminal paths', () => {
      const socket = mockSocket();
      handleUpgrade(mockReq('/random'), socket, Buffer.alloc(0));
      assert.ok(socket.destroyed, 'Socket should be destroyed for /random');
    });

    it('should destroy socket for /api paths', () => {
      const socket = mockSocket();
      handleUpgrade(mockReq('/api/health'), socket, Buffer.alloc(0));
      assert.ok(socket.destroyed, 'Socket should be destroyed for /api/health');
    });

    it('should not destroy socket for /terminal/ws path', () => {
      const socket = mockSocket();
      handleUpgrade(mockReq('/terminal/ws'), socket, Buffer.alloc(0));
      assert.ok(!socket.destroyed, 'Socket should NOT be destroyed for /terminal/ws');
    });
  });

  describe('handleRequest auth-bypass parity guard (#473)', () => {
    /**
     * Create a mock response that records the final status and body.
     * @returns {{ writeHead: Function, end: Function, statusCode: number, body: string, contentType: string }}
     */
    function mockRes() {
      return {
        statusCode: 0,
        body: '',
        contentType: '',
        writeHead(status, headers) {
          this.statusCode = status;
          this.contentType = (headers && (headers['Content-Type'] || headers['content-type'])) || '';
        },
        end(chunk) { if (chunk != null) this.body = String(chunk); }
      };
    }

    /**
     * Drive a GET through the real request handler with a mock req/res.
     * @param {string} url - Raw request target.
     * @returns {Promise<{statusCode:number, body:string, contentType:string}>}
     */
    async function get(url) {
      const req = { url, method: 'GET', headers: { host: 'localhost:3102' }, on() {} };
      const res = mockRes();
      await handleRequest(req, res);
      return res;
    }

    // Each of these is waved through UNAUTHENTICATED by Caddy (verified against a
    // live caddy run in #473) but does not resolve to the OpenClaw proxy in TC's
    // router, so before the guard it fell through to the SPA shell. Must now 404.
    const LEAK_VARIANTS = [
      '/openclaw-direct//abc/chat',   // duplicate slash → empty connId segment
      '//openclaw-direct/abc/chat',   // leading // → new URL host-hijacks to /abc/chat
      '/openclaw-direct%2Fabc/chat'   // %2F stays encoded in new URL → not the proxy route
    ];

    for (const url of LEAK_VARIANTS) {
      it(`refuses bypass-shaped fall-through ${JSON.stringify(url)} with 404, not the SPA shell`, async () => {
        const res = await get(url);
        assert.equal(res.statusCode, 404, 'must fail closed');
        assert.match(res.contentType, /application\/json/, 'must be the JSON 404, not index.html');
        assert.doesNotMatch(res.body, /<!doctype html>/i, 'must not serve the SPA shell');
        assert.match(res.body, /NOT_FOUND/);
      });
    }

    // POST /api/auth/credential authorizes on "arrived over loopback", treating
    // that as proof Caddy already authenticated the caller. In caddy mode the
    // server still binds an ungated 127.0.0.1 listener the operator's own
    // browser can reach, and parseBody parses any body as JSON whatever the
    // Content-Type — so a form with enctype="text/plain" is a CORS *simple*
    // request: no preflight, delivered, body parses, credential changed. The
    // reply is unreadable cross-origin, which is irrelevant to a write.
    describe('cross-site state-change guard', () => {
      /**
       * Drive one request through the real handler.
       * @param {string} method
       * @param {string} url
       * @param {Record<string,string>} extraHeaders
       * @returns {Promise<{statusCode:number, body:string, contentType:string}>}
       */
      async function send(method, url, extraHeaders) {
        const req = {
          url, method,
          headers: Object.assign({ host: 'localhost:3102' }, extraHeaders),
          // parseBody attaches data/end listeners; end immediately with no body.
          on(event, cb) { if (event === 'end') cb(); },
          socket: { remoteAddress: '127.0.0.1' }
        };
        const res = mockRes();
        await handleRequest(req, res);
        return res;
      }

      it('refuses the actual attack: a cross-site text/plain form POST to the credential route', async () => {
        const res = await send('POST', '/api/auth/credential', {
          'sec-fetch-site': 'cross-site',
          'content-type': 'text/plain;charset=UTF-8'   // what a form enctype produces
        });
        assert.equal(res.statusCode, 403, 'a cross-site credential write must be refused');
        assert.match(res.body, /CROSS_SITE_FORBIDDEN/);
      });

      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        it(`refuses cross-site ${method} on any API route, not just the credential one`, async () => {
          const res = await send(method, '/api/config', { 'sec-fetch-site': 'cross-site' });
          assert.equal(res.statusCode, 403, `${method} must be refused cross-site`);
          assert.match(res.body, /CROSS_SITE_FORBIDDEN/);
        });
      }

      /*
       * #864 — the Sec-Fetch-Site check above trusts the browser's own verdict,
       * and under DNS rebinding the browser honestly reports `same-origin`: the
       * page really is on `evil.example`, which really does resolve to
       * 127.0.0.1. Nothing is forged, so nothing above catches it. The Host
       * allowlist is the independent fact the guard checks against.
       */
      describe('#864 — Host allowlist (DNS rebinding)', () => {
        // A rebound page IS a browser, so it always carries `Sec-Fetch-Site`,
        // and it reports `same-origin` because as far as the browser knows it
        // is: the page really is on evil.example, which really does resolve to
        // 127.0.0.1. Nothing is forged, so nothing in the cross-site guard
        // above catches it. These send that header for that reason — not as
        // scaffolding.
        const BROWSER = { 'sec-fetch-site': 'same-origin' };

        it('refuses a state-changing request under a rebound name', async () => {
          const res = await send('POST', '/api/auth/credential',
            { host: 'evil.example:3102', ...BROWSER });
          assert.equal(res.statusCode, 403);
          assert.match(res.body, /HOST_NOT_SERVED/,
            'the cross-site guard cannot see this — the browser is telling the truth');
        });

        it('does NOT refuse a GET under an unserved Host — reads stay working', async () => {
          // The deliberate scope. A wrongly-derived allowlist (a proxy that
          // rewrites Host, a container name) must degrade to "writes refused",
          // never "the dashboard is gone" for a remote operator.
          const res = await send('GET', '/api/health', { host: 'weird-proxy-name:3102', ...BROWSER });
          assert.notEqual(res.statusCode, 403,
            'refusing reads too would take the dashboard away on a bad derivation');
        });

        it('does NOT refuse a header-less client under any Host — curl, scripts, the agent API', async () => {
          // The same exemption both sibling guards state explicitly. Costs the
          // guard nothing: a browser cannot suppress Sec-Fetch-Site from
          // script, so the attack always carries the marker that scopes it in.
          const res = await send('POST', '/api/config', { host: 'container-internal:3102' });
          assert.notEqual(res.statusCode, 403,
            'a header-less caller is not a cross-site vector and must keep working');
        });

        it('allows the served host it was already using', async () => {
          const res = await send('POST', '/api/config', { host: 'localhost:3102', ...BROWSER });
          assert.notEqual(res.statusCode, 403, 'localhost must never be refused');
        });

        for (const [label, host] of [
          ['a bracketed IPv6 address', '[::1]:3102'],
          ['a bare loopback IP', '127.0.0.1:3102'],
          ['ANY IP literal, not just ours', '10.11.12.13:3102']
        ]) {
          it(`allows ${label} — an IP cannot be rebound`, async () => {
            // Rebinding needs a NAME to point somewhere else; a literal has no
            // DNS step. A page at a different address posting here yields
            // Origin != Host, which the guards above already refuse — so
            // narrowing this would buy nothing and would require enumerating
            // interface addresses that change with the network.
            const res = await send('POST', '/api/config', { host, ...BROWSER });
            assert.notEqual(res.statusCode, 403, `${host} must be allowed`);
          });
        }

        it('refuses a state-changing browser request with no Host header at all', async () => {
          const res = await send('POST', '/api/config', { host: undefined, ...BROWSER });
          assert.equal(res.statusCode, 403, 'HTTP/1.1 requires Host; absent is not a pass');
          assert.match(res.body, /HOST_NOT_SERVED/);
        });

        it('does not exempt a setup-PREFIXED path outside the namespace', async () => {
          // `/api/setupsomething` shares the letters; the carve-out is on the
          // `/api/setup/` path segment, not a bare prefix match.
          const res = await send('POST', '/api/setupsomething',
            { host: 'evil.example:3102', ...BROWSER });
          assert.equal(res.statusCode, 403);
          assert.match(res.body, /HOST_NOT_SERVED/);
        });

        describe('_hostIsAllowed', () => {
          const allow = new Set(['localhost', 'studio.local', 'box.tail123.ts.net']);
          it('compares the parsed hostname, never a split on ":"', () => {
            assert.equal(_hostIsAllowed('[::1]:3102', allow), true,
              'splitting a bracketed IPv6 Host on ":" yields "[" and refuses every such request');
          });
          it('ignores the port', () => {
            assert.equal(_hostIsAllowed('studio.local:8443', allow), true);
          });
          it('is case-insensitive, as host names are', () => {
            assert.equal(_hostIsAllowed('STUDIO.local', allow), true);
          });
          it('refuses an unparseable Host rather than waving it through', () => {
            // A bare space cannot appear in a URL authority, so this reaches the
            // catch — verified by the assertion below being unreachable otherwise.
            assert.equal(_hostIsAllowed('a b', allow), false);
          });
          it('refuses an empty Host', () => {
            assert.equal(_hostIsAllowed('', allow), false);
          });
          it('refuses a name outside the list', () => {
            assert.equal(_hostIsAllowed('evil.example', allow), false);
          });
          it('allows an IP literal even against an EMPTY list — the fail-closed path', () => {
            // When the allowlist cannot be computed the caller passes an empty
            // set. Names are then all refused, but an IP is allowed on its own
            // reasoning, which does not depend on the list.
            assert.equal(_hostIsAllowed('127.0.0.1:3102', new Set()), true);
            assert.equal(_hostIsAllowed('evil.example', new Set()), false);
          });
        });
      });

      // The first version of this guard lived inside the `/api/` branch, which
      // left these open — and they are the worse half. `_openclawProxyHeaders`
      // rewrites origin/referer to the local origin and attaches
      // `Bearer <gatewayToken>`, so a cross-site POST here would reach the
      // OpenClaw gateway carrying the operator's token with the tell-tale Origin
      // stripped off. Pinned per-prefix so re-scoping the guard to `/api/` fails
      // loudly instead of silently reopening the proxies.
      for (const prefix of ['/terminal/x', '/openclaw-direct/abc/chat', '/openclaw/proj/thing']) {
        it(`refuses cross-site POST to ${prefix} — the guard is not /api/-only`, async () => {
          const res = await send('POST', prefix, { 'sec-fetch-site': 'cross-site' });
          assert.equal(res.statusCode, 403, `${prefix} must be refused cross-site`);
          assert.match(res.body, /CROSS_SITE_FORBIDDEN/);
        });
      }

      // WebSockets are NOT subject to the same-origin policy: any page can open
      // one to any host, no preflight, no CORS. So this is the sharper half of
      // the guard — a cross-site page can READ AND WRITE on the socket, which a
      // form post cannot, and /terminal/* proxies to a `--writable` ttyd.
      describe('WebSocket upgrades', () => {
        // A real duplex stream, not a stub: the ALLOWED path continues into the
        // proxy, which pipes to this socket. A plain object passes the refusal
        // cases and then explodes asynchronously on the ones that should succeed.
        /** @returns {{destroyed: boolean}} */
        function upgrade(headers) {
          const { PassThrough } = require('node:stream');
          const socket = new PassThrough();
          socket.destroyed = false;
          const orig = socket.destroy.bind(socket);
          socket.destroy = () => { socket.destroyed = true; orig(); };
          socket.remoteAddress = '127.0.0.1';
          try {
            handleUpgrade({ url: '/terminal/ws', method: 'GET', headers, socket }, socket, Buffer.alloc(0));
          } catch { /* downstream proxy setup is not what this asserts */ }
          return { destroyed: socket.destroyed };
        }

        /*
         * #864 — DNS rebinding. Both guards above decide "is this cross-site?"
         * relative to the request itself, so an attacker who controls DNS
         * satisfies them: point `evil.example` at 127.0.0.1, get the operator to
         * load it, and the browser reports same-origin because as far as it
         * knows it IS. Origin and Host agree — on a lie. The fix is to require
         * the name be one this install actually serves.
         */
        it('destroys the rebinding upgrade: Origin and Host AGREE, on a name we do not serve', () => {
          const r = upgrade({ host: 'evil.example:3102', origin: 'http://evil.example:3102' });
          assert.equal(r.destroyed, true,
            'agreeing with itself is not proof — /terminal/* proxies to a --writable ttyd');
        });

        it('still allows a no-Origin client under an unserved Host (not a browser, not a vector)', () => {
          const r = upgrade({ host: 'container-internal:3102' });
          assert.equal(r.destroyed, false,
            'headless consumers reach the socket by names no allowlist can know');
        });

        it('destroys an upgrade whose Origin is another site', () => {
          const r = upgrade({ host: 'localhost:3102', origin: 'https://evil.example' });
          assert.equal(r.destroyed, true, 'a cross-origin terminal socket must be refused');
        });

        it('allows a same-host Origin across scheme and port', () => {
          // The dashboard is reached over https through Caddy on one port and
          // http directly on another; both are the same machine. A strict origin
          // match would break the terminal on the install v5 makes default.
          const r = upgrade({ host: 'localhost:3102', origin: 'https://localhost:8443' });
          assert.equal(r.destroyed, false, 'same host over a different scheme/port must be allowed');
        });

        it('allows an upgrade with no Origin at all (non-browser clients)', () => {
          const r = upgrade({ host: 'localhost:3102' });
          assert.equal(r.destroyed, false, 'a header-less client is not a cross-site vector');
        });

        it('allows an IPv6-literal host — a tailnet address must not kill the terminal', () => {
          // Host arrives bracketed as `[fd7a:115c::1]:3102`. Splitting on ':'
          // yields '[', which can never equal the Origin side's
          // '[fd7a:115c::1]', so every terminal socket would be destroyed for an
          // operator whose dashboard is on IPv6 — dashboard loads, terminal
          // silently dead. Tailscale assigns every node an fd7a:115c::/48
          // address, so this is a normal way to reach TangleClaw.
          const r = upgrade({ host: '[fd7a:115c::1]:3102', origin: 'http://[fd7a:115c::1]:3102' });
          assert.equal(r.destroyed, false, 'an IPv6-literal same-host upgrade must be allowed');
        });

        it('still refuses a DIFFERENT IPv6 host', () => {
          const r = upgrade({ host: '[fd7a:115c::1]:3102', origin: 'http://[fd7a:115c::2]:3102' });
          assert.equal(r.destroyed, true);
        });

        // STRUCTURAL pin, not a behavioural one, and deliberately so. The
        // obvious test — upgrade to /openclaw-direct/... cross-origin, assert
        // the socket dies — CANNOT FAIL: resolveOpenclawPortDirect returns null
        // for an unknown connId and that branch destroys the socket too, so
        // deleting the guard leaves it green. A pin that cannot go red on the
        // mutation it exists to catch is worse than no pin, because it reads as
        // coverage. What actually matters is POSITION: the guard must run before
        // any branch dispatches, so every prefix is covered by construction
        // rather than one test per prefix.
        it('runs the origin check before any upgrade branch dispatches', () => {
          const src = require('node:fs').readFileSync(
            require('node:path').join(__dirname, '..', 'server.js'), 'utf8');
          // Bound the slice to handleUpgrade's own body. Running to EOF lets a
          // later function satisfy the branch search, which would make the
          // sanity assert below unfireable — the same "cannot fail" defect this
          // pin replaced.
          const fnStart = src.search(/function handleUpgrade\s*\(/);
          assert.notEqual(fnStart, -1, 'handleUpgrade must exist');
          const after = src.slice(fnStart + 1);
          const nextFn = after.search(/^function /m);
          const body = nextFn === -1 ? after : after.slice(0, nextFn);

          const guardAt = body.search(/_isSameOriginUpgrade\(/);
          assert.notEqual(guardAt, -1, 'handleUpgrade must consult the origin guard');
          // No trailing slash on /terminal: the real branch tests
          // startsWith('/terminal'), and a stricter pattern here matched nothing
          // inside the function.
          const firstBranchAt = Math.min(
            ...[/startsWith\('\/openclaw-direct/, /startsWith\('\/openclaw/, /startsWith\('\/terminal/]
              .map((re) => body.search(re))
              .filter((i) => i !== -1)
          );
          assert.notEqual(firstBranchAt, Infinity,
            'expected the upgrade branches to still exist inside handleUpgrade');
          assert.ok(guardAt < firstBranchAt,
            'the origin guard must precede every prefix branch — /terminal/* is a writable shell '
            + 'and the OpenClaw branches attach the operator gateway token');
        });

        it('refuses an unparseable Origin rather than waving it through', () => {
          const r = upgrade({ host: 'localhost:3102', origin: 'not a url' });
          assert.equal(r.destroyed, true, 'an Origin we cannot parse must fail closed');
        });
      });

      it('does NOT block a cross-site GET — navigation must keep working', async () => {
        // GET is excluded on purpose; a mutating GET is a bug in that route.
        const res = await send('GET', '/api/health', { 'sec-fetch-site': 'cross-site' });
        assert.notEqual(res.statusCode, 403, 'reads must not be refused by the CSRF guard');
      });

      it('allows a request with NO Sec-Fetch-Site — curl, scripts, the agent-facing API', async () => {
        // This is the compatibility contract: non-browser callers omit the
        // header entirely and are not a CSRF vector. If this ever 403s, every
        // documented curl example in the project guide breaks at once.
        const res = await send('POST', '/api/config', {});
        assert.notEqual(res.statusCode, 403, 'a header-less caller must not be refused');
        assert.doesNotMatch(res.body, /CROSS_SITE_FORBIDDEN/);
      });

      it('allows same-origin — the dashboard\'s own fetches', async () => {
        const res = await send('POST', '/api/config', { 'sec-fetch-site': 'same-origin' });
        assert.notEqual(res.statusCode, 403);
      });

      it('allows same-site, and that narrowness is deliberate', async () => {
        // Refusing same-site too would need an attacker holding a sibling
        // subdomain of the operator's own host, and would break a legitimate
        // multi-subdomain deployment. Pinned so a future widening is a decision
        // someone makes on purpose rather than a silent tightening.
        const res = await send('POST', '/api/config', { 'sec-fetch-site': 'same-site' });
        assert.notEqual(res.statusCode, 403);
      });
    });

    it('still serves the real /manifest.json file (a genuine bypass path with a handler)', async () => {
      const res = await get('/manifest.json');
      assert.equal(res.statusCode, 200);
      assert.match(res.contentType, /json/);
    });

    it('does not over-fire: an ordinary unknown SPA route still serves the shell', async () => {
      // A non-bypass client route has no `.` in its path, so the SPA fallback
      // serves index.html — the guard must leave this untouched.
      const res = await get('/some/spa/route');
      assert.equal(res.statusCode, 200);
      assert.match(res.contentType, /text\/html/);
    });
  });

  describe('OpenClaw proxy Authorization handling (#470)', () => {
    const TOKEN = 'gw-secret-token-abc';
    // In caddy-gated ingress the browser attaches its caddy Basic credential to
    // same-origin requests; the OpenClaw gateway authenticates only on the injected
    // gateway token, so that Basic header must never reach the downstream host.
    const CADDY_BASIC = 'Basic amFzb246c3VwZXJzZWNyZXQ=';

    describe('_openclawProxyHeaders (HTTP path)', () => {
      it('overwrites an incoming Authorization with the gateway Bearer token', () => {
        const out = _openclawProxyHeaders({ authorization: CADDY_BASIC, accept: '*/*' }, 5001, TOKEN);
        assert.equal(out.authorization, `Bearer ${TOKEN}`);
      });

      it('strips an incoming Authorization when no gateway token is configured (no Basic leak)', () => {
        const out = _openclawProxyHeaders({ authorization: CADDY_BASIC }, 5001, null);
        assert.ok(!('authorization' in out), 'Basic credential must not be forwarded downstream');
      });

      it('pins host and rewrites origin/referer to the local upstream', () => {
        const out = _openclawProxyHeaders(
          { origin: 'https://tc.example.com', referer: 'https://tc.example.com/x' }, 5001, TOKEN
        );
        assert.equal(out.host, '127.0.0.1:5001');
        assert.equal(out.origin, 'http://127.0.0.1:5001');
        assert.equal(out.referer, 'http://127.0.0.1:5001/');
      });
    });

    describe('_openclawWsRequestLines (WebSocket path)', () => {
      /** Extract the authorization header value emitted in the raw line list, or null. */
      function authOf(lines) {
        const l = lines.find((s) => s.toLowerCase().startsWith('authorization:'));
        return l ? l.slice(l.indexOf(':') + 1).trim() : null;
      }

      it('drops the browser Basic header and injects the gateway Bearer token', () => {
        const lines = _openclawWsRequestLines(
          { authorization: CADDY_BASIC, upgrade: 'websocket' }, '/ws', 5001, TOKEN
        );
        assert.equal(authOf(lines), `Bearer ${TOKEN}`);
        // The Basic value must appear nowhere in the forwarded block.
        assert.ok(!lines.some((s) => s.includes('Basic ')), 'Basic credential must not be forwarded');
      });

      it('injects the gateway Bearer token when the handshake carried no Authorization', () => {
        const lines = _openclawWsRequestLines({ upgrade: 'websocket' }, '/ws', 5001, TOKEN);
        assert.equal(authOf(lines), `Bearer ${TOKEN}`);
      });

      it('emits NO Authorization line and drops the Basic header when no token is configured', () => {
        const lines = _openclawWsRequestLines({ authorization: CADDY_BASIC }, '/ws', 5001, null);
        assert.equal(authOf(lines), null, 'no gateway token → no Authorization forwarded');
        assert.ok(!lines.some((s) => s.includes('Basic ')));
      });

      it('pins the request line + Host and rewrites origin/referer; preserves WS headers', () => {
        const lines = _openclawWsRequestLines({
          origin: 'https://tc.example.com',
          referer: 'https://tc.example.com/x',
          upgrade: 'websocket',
          connection: 'Upgrade',
          'sec-websocket-key': 'abc123'
        }, '/openclaw-direct/c1/ws', 5001, TOKEN);
        assert.equal(lines[0], 'GET /openclaw-direct/c1/ws HTTP/1.1');
        assert.equal(lines[1], 'Host: 127.0.0.1:5001');
        assert.ok(lines.includes('origin: http://127.0.0.1:5001'));
        assert.ok(lines.includes('referer: http://127.0.0.1:5001/'));
        assert.ok(lines.includes('sec-websocket-key: abc123'));
        assert.ok(lines.includes('upgrade: websocket'));
        // header block terminates with a blank line
        assert.equal(lines[lines.length - 1], '');
        assert.equal(lines[lines.length - 2], '');
      });
    });

    it('HTTP and WS paths agree on the Authorization outcome (symmetry, #470)', () => {
      for (const token of [TOKEN, null]) {
        const http = _openclawProxyHeaders({ authorization: CADDY_BASIC }, 5001, token);
        const wsLines = _openclawWsRequestLines({ authorization: CADDY_BASIC }, '/ws', 5001, token);
        const wsAuth = wsLines.find((s) => s.toLowerCase().startsWith('authorization:'));
        const wsAuthVal = wsAuth ? wsAuth.slice(wsAuth.indexOf(':') + 1).trim() : undefined;
        assert.equal(http.authorization, wsAuthVal, `mismatch for token=${token}`);
      }
    });
  });
});
