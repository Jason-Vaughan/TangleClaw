'use strict';

/*
 * The service worker is a consumer of the wrap progress stream (#185), and it
 * was an unexamined one.
 *
 * `sw.js` is registered at scope `/`, so it controls `session.html` and sits
 * between that page's `EventSource` and `GET /api/sessions/:p/wrap/stream/:id`.
 * Its network-first `/api/` branch cloned and `cache.put` every ok GET — and
 * the wrap stream is the first streaming GET this app has ever served. Three
 * things followed: one permanent CacheStorage entry per wrap run, under a
 * random per-run URL nothing will ever request again; a `cache.put` of a body
 * that is still open, which rejects when the run ends and the stream aborts,
 * with no `.catch()` to receive it; and a reconnect that could be served the
 * stale first frames instead of reaching the server.
 *
 * These tests RUN the fetch handler rather than grepping it. A source-string
 * pin would pass on a handler that reads correctly and behaves wrongly, and
 * the whole finding here is a behaviour nobody had executed.
 */

const { describe, it, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SW_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'sw.js'), 'utf8');

/**
 * A minimal `Headers`: the handler only reads `Content-Type`.
 * @param {Object<string,string>} init - Header map.
 * @returns {{get: (name: string) => string|null}} The headers object.
 */
function makeHeaders(init) {
  const map = new Map(Object.entries(init || {}).map(([k, v]) => [k.toLowerCase(), v]));
  return { get: (name) => (map.has(String(name).toLowerCase()) ? map.get(String(name).toLowerCase()) : null) };
}

/**
 * A response double carrying just what the fetch handler touches.
 * @param {{ok?: boolean, contentType?: string}} cfg - Shape.
 * @returns {object} The response, with `.cloned` counting `clone()` calls.
 */
function makeResponse(cfg) {
  const res = {
    ok: cfg.ok !== false,
    status: cfg.ok === false ? 500 : 200,
    statusText: 'OK',
    headers: makeHeaders(cfg.contentType ? { 'Content-Type': cfg.contentType } : {}),
    cloned: 0
  };
  res.clone = () => { res.cloned += 1; return { ...res, clone: res.clone }; };
  return res;
}

/**
 * Load `sw.js` into a sandbox and return the handlers it registered plus the
 * cache spy. `fetchImpl` answers the handler's own `fetch`.
 *
 * @param {{fetchImpl: Function}} cfg - Sandbox configuration.
 * @returns {{handlers: object, puts: object[], putRejects: boolean, setPutRejects: Function}} The sandbox surface.
 */
function loadSw(cfg) {
  const handlers = {};
  const puts = [];
  const state = { putRejects: false };
  const cache = {
    put: (request, response) => {
      puts.push({ request, response });
      return state.putRejects
        ? Promise.reject(new Error('Failed to execute put: Response body is already used'))
        : Promise.resolve();
    },
    addAll: () => Promise.resolve(),
    keys: () => Promise.resolve([]),
    match: () => Promise.resolve(undefined)
  };
  const sandbox = {
    console,
    URL,
    Headers: makeHeaders,
    Response: function Response(body, init) { return { body, ...(init || {}) }; },
    fetch: cfg.fetchImpl,
    caches: {
      open: () => Promise.resolve(cache),
      match: () => Promise.resolve(undefined),
      keys: () => Promise.resolve([]),
      delete: () => Promise.resolve(true)
    },
    self: {
      addEventListener: (type, fn) => { handlers[type] = fn; },
      skipWaiting: () => {},
      clients: { claim: () => {} }
    }
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(SW_SRC, sandbox);
  return { handlers, puts, setPutRejects: (v) => { state.putRejects = v; } };
}

/**
 * Drive the fetch handler for one request and settle its `respondWith`.
 * @param {object} handlers - From `loadSw`.
 * @param {{url: string, method?: string, mode?: string}} req - Request double.
 * @returns {Promise<object>} What the handler responded with.
 */
async function fetchEvent(handlers, req) {
  let responded;
  handlers.fetch({
    request: { method: req.method || 'GET', mode: req.mode || 'cors', url: req.url },
    respondWith: (p) => { responded = p; }
  });
  return responded;
}

const STREAM_URL = 'https://tc.test/api/sessions/demo/wrap/stream/0123456789abcdef0123456789abcdef';
const STATUS_URL = 'https://tc.test/api/sessions/demo/wrap/status';

describe('the service worker and the wrap progress stream (#185)', () => {
  let sw;
  let served;

  beforeEach(() => {
    served = null;
    sw = loadSw({ fetchImpl: () => Promise.resolve(served) });
  });

  it('does not cache the stream — one entry per wrap run, under a URL nothing re-requests', async () => {
    served = makeResponse({ contentType: 'text/event-stream; charset=utf-8' });

    const out = await fetchEvent(sw.handlers, { url: STREAM_URL });

    assert.equal(out, served, 'the stream is still served through');
    assert.deepEqual(sw.puts, [], 'and nothing about it is stored');
    assert.equal(served.cloned, 0, 'not even cloned — a clone of a live body is a second open reader');
  });

  it('still caches an ordinary /api/ GET beside it, so the exclusion is the stream and not the branch', async () => {
    served = makeResponse({ contentType: 'application/json' });

    const out = await fetchEvent(sw.handlers, { url: STATUS_URL });

    assert.equal(out, served);
    assert.equal(sw.puts.length, 1, 'the network-first cache is intact for real API reads');
  });

  it('is keyed on the response being a stream, not on the route — a second streaming endpoint is covered by construction', async () => {
    served = makeResponse({ contentType: 'text/event-stream' });

    await fetchEvent(sw.handlers, { url: 'https://tc.test/api/some/future/stream' });

    assert.deepEqual(sw.puts, [], 'no path list to remember to update');
  });

  it('a rejected cache.put never reaches the fetch handler\'s promise', async () => {
    // A put can reject for reasons the content-type check cannot foresee —
    // storage quota, an aborted body. An unhandled rejection in a service
    // worker is invisible to the page; worse, a rejection that propagated
    // would turn a response that was already served into a network error.
    sw.setPutRejects(true);
    served = makeResponse({ contentType: 'application/json' });

    const out = await fetchEvent(sw.handlers, { url: STATUS_URL });

    assert.equal(out, served, 'the response is delivered regardless of the cache write');
    // Give the put's rejection a turn to surface if it is unhandled.
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('a non-ok stream response is not cached either', async () => {
    // The 404 the route answers for an unknown runId.
    served = makeResponse({ ok: false, contentType: 'application/json' });

    await fetchEvent(sw.handlers, { url: STREAM_URL });

    assert.deepEqual(sw.puts, []);
  });
});
