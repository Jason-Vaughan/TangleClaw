'use strict';

/*
 * Frontend regression tests for #80 — the shared api() helpers in landing.js,
 * session.js, and openclaw-view.js must surface server error messages via
 * a `lastError` side-channel so form handlers can render the real 4xx/5xx
 * reason instead of a generic "Check server logs" fallback.
 *
 * Each api() helper is isolated via a small vm sandbox. We stub fetch to
 * return various response shapes and assert api.lastError / api.lastErrorCode
 * are populated correctly.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/**
 * Extract the `async function api(url, opts)` definition from a frontend
 * script file. Each file defines its own api() inside a larger module; we
 * pull just that function and evaluate it in a minimal sandbox so the test
 * doesn't need to stub every other landing-page / session-page global.
 * @param {string} filePath
 * @returns {string} The `async function api(...) { ... }` source, including
 *   the trailing `api.lastError = null;` initializers.
 */
function extractApiFn(filePath) {
  const src = fs.readFileSync(filePath, 'utf8');
  const start = src.indexOf('async function api(');
  assert.ok(start >= 0, `api() not found in ${filePath}`);

  // Walk braces from the first `{` after the function header.
  const braceStart = src.indexOf('{', start);
  let depth = 0;
  let i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) { i++; break; }
    }
  }

  // Capture the two initializer lines that follow (api.lastError = null, etc.)
  let after = src.slice(i);
  const initMatch = after.match(/^\s*api\.lastError\s*=\s*null;\s*\n\s*api\.lastErrorCode\s*=\s*null;/);
  const tail = initMatch ? initMatch[0] : '';

  return src.slice(start, i) + '\n' + tail;
}

/**
 * Build a sandbox with fetch + setConnected stubbed, evaluate the extracted
 * api() function into it, and return the sandbox (with `api` attached).
 * @param {string} filePath
 * @param {Function} fetchImpl - async (url, opts) => ({ ok, status, json })
 * @returns {object} sandbox with { api, setConnectedCalls }
 */
function loadApi(filePath, fetchImpl) {
  const setConnectedCalls = [];
  const sandbox = {
    console: { error() {}, log() {} },
    fetch: fetchImpl,
    setConnected: (v) => { setConnectedCalls.push(v); },
    Error
  };
  vm.createContext(sandbox);
  vm.runInContext(extractApiFn(filePath), sandbox);
  sandbox.setConnectedCalls = setConnectedCalls;
  return sandbox;
}

const LANDING = path.join(__dirname, '..', 'public', 'landing.js');
const SESSION = path.join(__dirname, '..', 'public', 'session.js');
const OPENCLAW = path.join(__dirname, '..', 'public', 'openclaw-view.js');

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
  for (const [label, filePath] of [['landing.js', LANDING], ['session.js', SESSION], ['openclaw-view.js', OPENCLAW]]) {
    describe(label, () => {
      it('surfaces server error message via api.lastError on 4xx', async () => {
        const ctx = loadApi(filePath, async () =>
          fakeResponse(409, { error: 'Directory "Foo" already exists in /projects', code: 'CONFLICT' })
        );
        const result = await ctx.api('/api/projects', { method: 'POST' });
        assert.equal(result, null, 'non-OK response must return null (callers check !result)');
        assert.equal(ctx.api.lastError, 'Directory "Foo" already exists in /projects');
        assert.equal(ctx.api.lastErrorCode, 'CONFLICT');
      });

      it('surfaces generic HTTP code when server body has no error field', async () => {
        const ctx = loadApi(filePath, async () => fakeResponse(500, {}));
        await ctx.api('/api/broken');
        assert.equal(ctx.api.lastError, 'HTTP 500');
        assert.equal(ctx.api.lastErrorCode, null);
      });

      it('clears lastError on a successful response', async () => {
        const ctx = loadApi(filePath, async () => fakeResponse(200, { ok: true }));
        // Pre-seed a stale error to prove the success path resets it
        ctx.api.lastError = 'stale';
        ctx.api.lastErrorCode = 'STALE';
        const result = await ctx.api('/api/health');
        assert.deepEqual(result, { ok: true });
        assert.equal(ctx.api.lastError, null);
        assert.equal(ctx.api.lastErrorCode, null);
      });

      it('populates lastError on a network error (TypeError: Failed to fetch)', async () => {
        const ctx = loadApi(filePath, async () => {
          const err = new TypeError('Failed to fetch');
          throw err;
        });
        const result = await ctx.api('/api/unreachable');
        assert.equal(result, null);
        assert.ok(ctx.api.lastError, 'lastError must be populated on network failure');
      });
    });
  }

  describe('landing.js / session.js — setConnected integration', () => {
    it('calls setConnected(false) on network error', async () => {
      const ctx = loadApi(LANDING, async () => { throw new TypeError('Failed to fetch'); });
      await ctx.api('/api/health');
      assert.ok(ctx.setConnectedCalls.includes(false), 'network error must flip connected=false');
    });

    it('calls setConnected(true) on success', async () => {
      const ctx = loadApi(LANDING, async () => fakeResponse(200, { ok: true }));
      await ctx.api('/api/health');
      assert.ok(ctx.setConnectedCalls.includes(true), 'success must flip connected=true');
    });

    it('does NOT flip setConnected on a 4xx (server reachable, just rejecting)', async () => {
      const ctx = loadApi(LANDING, async () => fakeResponse(409, { error: 'nope' }));
      await ctx.api('/api/thing');
      // Neither true nor false — server was reachable, just returned non-OK
      assert.equal(ctx.setConnectedCalls.length, 0);
    });
  });
});
