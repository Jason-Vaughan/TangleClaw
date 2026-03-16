'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { matchRoute, route, parseQuery, handleUpgrade } = require('../server');

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
});
