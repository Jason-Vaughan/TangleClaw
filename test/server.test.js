'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { matchRoute, route, parseQuery } = require('../server');

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
});
