'use strict';

/*
 * Frontend regression tests for #80 — the shared api() helper must surface
 * server error messages via a `lastError` side-channel so form handlers can
 * render the real 4xx/5xx reason instead of a generic "Check server logs"
 * fallback.
 *
 * After #82 the api()/apiMutate() implementations live in a single shared
 * module at public/api-helper.js exposed via window.tcCreateApi /
 * window.tcCreateApiMutate factories. landing.js, session.js, and
 * openclaw-view.js call the factories at module load. These tests load the
 * shared helper into a vm sandbox once, build a per-page api() via the
 * factory, and exercise each branch.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HELPER_PATH = path.join(__dirname, '..', 'public', 'api-helper.js');
const HELPER_SRC = fs.readFileSync(HELPER_PATH, 'utf8');

/**
 * Build a sandbox with fetch + an optional setConnected stub, evaluate the
 * shared api-helper into it, and create an api() via the factory. Mirrors
 * the way each page script binds the helper at module load: landing.js and
 * session.js pass `setConnected`; openclaw-view.js does not.
 *
 * @param {Function} fetchImpl - async (url, opts) => ({ ok, status, json })
 * @param {object} [opts]
 * @param {boolean} [opts.withSetConnected=true] - Pass a setConnected hook
 *   to the factory (true mirrors landing/session, false mirrors openclaw).
 * @returns {object} sandbox with { api, apiMutate, setConnectedCalls }
 */
function buildApi(fetchImpl, opts = {}) {
  const withSetConnected = opts.withSetConnected !== false;
  const setConnectedCalls = [];
  const sandbox = {
    console: { error() {}, log() {} },
    fetch: fetchImpl,
    Error,
    TypeError,
    window: {}
  };
  vm.createContext(sandbox);
  vm.runInContext(HELPER_SRC, sandbox);

  const factoryOpts = withSetConnected
    ? { setConnected: (v) => { setConnectedCalls.push(v); } }
    : undefined;
  const api = sandbox.window.tcCreateApi(factoryOpts);
  const apiMutate = sandbox.window.tcCreateApiMutate(api);
  return { api, apiMutate, setConnectedCalls, window: sandbox.window };
}

/**
 * Minimal fake Response object matching what api() reads: ok, status, json().
 * @param {number} status
 * @param {object} body
 */
function fakeResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  };
}

describe('Frontend api() helper — lastError side-channel (#80)', () => {
  // The same factory backs all three pages. We exercise both bindings
  // (with/without setConnected) to mirror the real call sites.
  for (const [label, withSetConnected] of [
    ['landing.js / session.js binding (with setConnected)', true],
    ['openclaw-view.js binding (no setConnected)', false]
  ]) {
    describe(label, () => {
      it('surfaces server error message via api.lastError on 4xx', async () => {
        const ctx = buildApi(
          async () => fakeResponse(409, { error: 'Directory "Foo" already exists in /projects', code: 'CONFLICT' }),
          { withSetConnected }
        );
        const result = await ctx.api('/api/projects', { method: 'POST' });
        assert.equal(result, null, 'non-OK response must return null (callers check !result)');
        assert.equal(ctx.api.lastError, 'Directory "Foo" already exists in /projects');
        assert.equal(ctx.api.lastErrorCode, 'CONFLICT');
      });

      it('surfaces generic HTTP code when server body has no error field', async () => {
        const ctx = buildApi(async () => fakeResponse(500, {}), { withSetConnected });
        await ctx.api('/api/broken');
        assert.equal(ctx.api.lastError, 'HTTP 500');
        assert.equal(ctx.api.lastErrorCode, null);
      });

      it('clears lastError on a successful response', async () => {
        const ctx = buildApi(async () => fakeResponse(200, { ok: true }), { withSetConnected });
        // Pre-seed a stale error to prove the success path resets it
        ctx.api.lastError = 'stale';
        ctx.api.lastErrorCode = 'STALE';
        const result = await ctx.api('/api/health');
        assert.deepEqual(result, { ok: true });
        assert.equal(ctx.api.lastError, null);
        assert.equal(ctx.api.lastErrorCode, null);
      });

      it('populates lastError on a network error (TypeError: Failed to fetch)', async () => {
        const ctx = buildApi(async () => {
          const err = new TypeError('Failed to fetch');
          throw err;
        }, { withSetConnected });
        const result = await ctx.api('/api/unreachable');
        assert.equal(result, null);
        assert.equal(ctx.api.lastError, 'Connection lost.');
      });
    });
  }

  describe('landing.js / session.js — setConnected integration', () => {
    it('calls setConnected(false) on network error', async () => {
      const ctx = buildApi(async () => { throw new TypeError('Failed to fetch'); });
      await ctx.api('/api/health');
      assert.ok(ctx.setConnectedCalls.includes(false), 'network error must flip connected=false');
    });

    it('calls setConnected(true) on success', async () => {
      const ctx = buildApi(async () => fakeResponse(200, { ok: true }));
      await ctx.api('/api/health');
      assert.ok(ctx.setConnectedCalls.includes(true), 'success must flip connected=true');
    });

    it('does NOT flip setConnected on a 4xx (server reachable, just rejecting)', async () => {
      const ctx = buildApi(async () => fakeResponse(409, { error: 'nope' }));
      await ctx.api('/api/thing');
      // Neither true nor false — server was reachable, just returned non-OK
      assert.equal(ctx.setConnectedCalls.length, 0);
    });
  });

  describe('openclaw-view.js — no setConnected branch', () => {
    it('does not throw when setConnected is omitted', async () => {
      const ctx = buildApi(async () => fakeResponse(200, { ok: true }), { withSetConnected: false });
      const result = await ctx.api('/api/health');
      assert.deepEqual(result, { ok: true });
    });

    it('still surfaces "Connection lost." on network error even without setConnected', async () => {
      const ctx = buildApi(async () => { throw new TypeError('Failed to fetch'); }, { withSetConnected: false });
      await ctx.api('/api/unreachable');
      assert.equal(ctx.api.lastError, 'Connection lost.');
    });
  });

  describe('apiMutate factory', () => {
    it('sends method + JSON body through the bound api()', async () => {
      let captured = null;
      const ctx = buildApi(async (url, opts) => {
        captured = { url, opts };
        return fakeResponse(200, { ok: true });
      });
      const result = await ctx.apiMutate('/api/projects', 'POST', { name: 'Foo' });
      assert.deepEqual(result, { ok: true });
      assert.equal(captured.url, '/api/projects');
      assert.equal(captured.opts.method, 'POST');
      assert.equal(captured.opts.headers['Content-Type'], 'application/json');
      assert.equal(captured.opts.body, JSON.stringify({ name: 'Foo' }));
    });

    it('propagates lastError from the bound api() on 4xx', async () => {
      const ctx = buildApi(async () => fakeResponse(409, { error: 'taken', code: 'CONFLICT' }));
      const result = await ctx.apiMutate('/api/projects', 'POST', {});
      assert.equal(result, null);
      assert.equal(ctx.api.lastError, 'taken');
      assert.equal(ctx.api.lastErrorCode, 'CONFLICT');
    });
  });

  describe('Factory exposes both helpers on window', () => {
    it('exposes tcCreateApi and tcCreateApiMutate', () => {
      const ctx = buildApi(async () => fakeResponse(200, {}));
      assert.equal(typeof ctx.window.tcCreateApi, 'function');
      assert.equal(typeof ctx.window.tcCreateApiMutate, 'function');
    });
  });
});
