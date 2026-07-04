'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { matchRoute, route, parseQuery, handleUpgrade, handleRequest } = require('../server');

describe('server', () => {
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
});
