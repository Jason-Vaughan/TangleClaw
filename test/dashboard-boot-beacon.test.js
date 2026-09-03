'use strict';

/*
 * #817 — the dashboard's boot beacon.
 *
 * On 2026-07-31 the dashboard loaded blank for twenty minutes and cleared on
 * its own: four `GET /` requests, no `/api/projects` after any of them, every
 * server signal green. The precached shell scripts never show in the access
 * log on a healthy load either, and the missing projects fetch is ambiguous
 * (an operator opening a session page directly leaves the same gap). So the
 * shell now says, once, that it booted — and only after it actually has.
 *
 * Two halves, both driven for real:
 *   - the route, through the real server: it answers 204 and the `Dashboard
 *     booted` line lands at info with the cache name the browser reported,
 *     beside the ordinary access-log line;
 *   - the client, by lifting the REAL `loadProjects` (and the beacon helpers)
 *     out of public/landing.js into a sandbox: no beacon while the projects
 *     fetch fails, exactly one after the first success, sent after the shell
 *     rendered — the lift-and-run pattern of test/landing-unreachable-state.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const vm = require('node:vm');

const logger = require('../lib/logger');

logger.setLevel('error');

const store = require('../lib/store');

const LANDING_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'public', 'landing.js'), 'utf8');

/**
 * Slice a top-level function (declaration + body) out of source text by
 * brace-matching, so the sandbox runs the REAL code rather than a copy.
 *
 * @param {string} src - File source text.
 * @param {string} decl - Declaration to find, e.g. `async function loadProjects()`.
 * @returns {string} The declaration plus its balanced body.
 */
function liftFunction(src, decl) {
  const start = src.indexOf(decl);
  assert.notEqual(start, -1, `${decl} must exist`);
  const bodyStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  assert.fail(`${decl} body must close`);
}

/**
 * Run `fn` with the logger capturing info-and-above to an array, restoring
 * the quiet test posture afterwards.
 *
 * @param {() => Promise<any>} fn - Work to run while capturing.
 * @returns {Promise<string[]>} The captured lines.
 */
async function captureLog(fn) {
  const lines = [];
  logger.setLevel('info');
  logger.setConsoleStream({ write: (s) => lines.push(s) });
  try {
    await fn();
  } finally {
    logger.setConsoleStream(null);
    logger.setLevel('error');
  }
  return lines;
}

describe('POST /api/dashboard/boot — the beacon reaches the log (#817)', () => {
  let tmpDir;
  let server;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-boot-beacon-'));
    store._setBasePath(tmpDir);
    store.init();
    const { createServer } = require('../server');
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * POST to the running server the way the dashboard does — JSON content type,
   * which the `/api/` form-body rule requires.
   *
   * @param {string|null} raw - Body text, or null for an empty body.
   * @returns {Promise<{status: number, text: string}>}
   */
  function post(raw) {
    return new Promise((resolve, reject) => {
      const headers = { 'Content-Type': 'application/json' };
      if (raw !== null) headers['Content-Length'] = Buffer.byteLength(raw);
      const req = http.request({
        hostname: '127.0.0.1', port: server.address().port,
        path: '/api/dashboard/boot', method: 'POST', headers
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      if (raw !== null) req.write(raw);
      req.end();
    });
  }

  it('answers 204 and logs the reported cache name at info, beside the access-log line', async () => {
    let res;
    const lines = await captureLog(async () => {
      res = await post(JSON.stringify({ cacheName: 'tangleclaw-v3-60', controlled: true }));
    });
    assert.equal(res.status, 204);
    assert.equal(res.text, '', 'nothing to parse — a 204 carries no body');
    const joined = lines.join('');
    assert.match(joined, /\[INFO\] \[server\] Dashboard booted cacheName=tangleclaw-v3-60 swControlled=true/,
      'the positive signal, with what the browser booted against');
    assert.match(joined, /POST \/api\/dashboard\/boot status=204/,
      'the ordinary access-log line still lands, so the beacon is greppable two ways');
  });

  it('a null cache name is a valid boot — a browser with no TangleClaw cache still booted', async () => {
    let res;
    const lines = await captureLog(async () => {
      res = await post(JSON.stringify({ cacheName: null, controlled: false }));
    });
    assert.equal(res.status, 204);
    assert.match(lines.join(''), /Dashboard booted cacheName=null swControlled=false/);
  });

  it('an empty body is a boot with nothing measured, not a refusal', async () => {
    let res;
    const lines = await captureLog(async () => { res = await post(null); });
    assert.equal(res.status, 204);
    assert.match(lines.join(''), /Dashboard booted cacheName=null swControlled=false/);
  });

  it('a non-string cache name is refused and logs no boot', async () => {
    let res;
    const lines = await captureLog(async () => {
      res = await post(JSON.stringify({ cacheName: 42 }));
    });
    assert.equal(res.status, 400);
    assert.equal(JSON.parse(res.text).code, 'BAD_REQUEST');
    assert.doesNotMatch(lines.join(''), /Dashboard booted/,
      'a refused beacon must not read as a boot in the log');
  });

  it('a browser-supplied cache name is bounded before it reaches the log', async () => {
    const lines = await captureLog(async () => {
      await post(JSON.stringify({ cacheName: 'x'.repeat(1000) }));
    });
    const m = lines.join('').match(/Dashboard booted cacheName=(x+) /);
    assert.ok(m, 'the boot is still logged');
    assert.equal(m[1].length, 200);
  });

  /**
   * GET a path from the running server, discarding the body.
   * @param {string} urlPath - Path.
   * @returns {Promise<number>} The status code.
   */
  function get(urlPath) {
    return new Promise((resolve, reject) => {
      const req = http.request({
        hostname: '127.0.0.1', port: server.address().port, path: urlPath, method: 'GET'
      }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
      req.on('error', reject);
      req.end();
    });
  }

  // The pair the runbook reads is `GET /` then `Dashboard booted`. Static
  // responses are logged at debug, which a default install never writes, so
  // without the lines below the first half of the pair is invisible exactly
  // where the runbook sends the operator to look (Critic, #817).
  it('the dashboard document is logged at info on a default install, so the pair is observable', async () => {
    let status;
    const lines = await captureLog(async () => { status = await get('/'); });
    assert.equal(status, 200);
    assert.match(lines.join(''), /\[INFO\] \[server\] GET \/ status=200 duration=\d+ms document=index\.html/);
  });

  it('the SPA fallback and the session page are navigations too, and say which document answered', async () => {
    const lines = await captureLog(async () => {
      assert.equal(await get('/some-client-route'), 200);
      assert.equal(await get('/session/some-session'), 200);
    });
    const joined = lines.join('');
    assert.match(joined, /\[INFO\] \[server\] GET \/some-client-route status=200 .*document=index\.html/);
    assert.match(joined, /\[INFO\] \[server\] GET \/session\/some-session status=200 .*document=session\.html/,
      'the innocent explanation for a beacon-less GET / must itself be in the log');
  });

  it('every other static asset stays at debug — the info log does not become an asset log', async () => {
    const lines = await captureLog(async () => { assert.equal(await get('/style.css'), 200); });
    assert.doesNotMatch(lines.join(''), /GET \/style\.css/);
  });
});

describe('the dashboard sends the beacon after the shell boots, not before (#817)', () => {
  /**
   * A sandbox running the REAL `loadProjects` and beacon helpers from
   * public/landing.js, with the renderers stubbed to record their order and
   * `api`/`fetch` under the test's control.
   *
   * @param {object} [opts]
   * @param {string[]|null} [opts.cacheKeys] - What `caches.keys()` answers; null
   *   leaves Cache Storage undefined, as on a browser without it.
   * @param {boolean} [opts.controlled] - Whether a worker controls the page.
   * @param {boolean} [opts.fetchFails] - Make the beacon's fetch reject.
   * @param {number} [opts.fetchStatus] - Status the beacon's fetch resolves
   *   with (default 204); anything outside 2xx resolves with `ok: false`.
   * @returns {object} The context, with `calls` (fetch calls), `marks` (order
   *   of renders and beacon sends) and `serverUp` (what `api` answers).
   */
  function loadShell(opts) {
    opts = opts || {};
    const marks = [];
    const calls = [];
    const errors = [];
    const sandbox = {
      console: { error: (...a) => errors.push(a.join(' ')), log() {}, warn() {} },
      JSON,
      Object,
      state: { projects: [], awareness: {}, projectsScan: null, orphanHooksRepairInFlight: true },
      serverUp: true,
      document: { getElementById: () => null },
      collectTags() { marks.push('collectTags'); },
      collectEngines() { marks.push('collectEngines'); },
      renderProjects() { marks.push('renderProjects'); },
      renderSessionCount() { marks.push('renderSessionCount'); },
      updateUnregisteredToggle() { marks.push('updateUnregisteredToggle'); },
      loadOrphanHooksInventory: async () => {},
      fetch: async (url, init) => {
        marks.push('beacon');
        calls.push({ url, init });
        if (opts.fetchFails) throw new TypeError('Failed to fetch');
        const status = opts.fetchStatus || 204;
        return { status, ok: status >= 200 && status < 300 };
      }
    };
    // Mirrors the real contract: `api` answers data when the server is up and
    // null when it is not; the test decides which.
    sandbox.api = async (url) => {
      if (!sandbox.serverUp) return null;
      if (url.startsWith('/api/projects')) return { projects: [{ name: 'b' }, { name: 'a' }], scan: null };
      if (url === '/api/awareness') return { projects: [] };
      return null;
    };
    if (opts.cacheKeys) sandbox.caches = { keys: async () => opts.cacheKeys };
    sandbox.navigator = { serviceWorker: { controller: opts.controlled ? {} : null } };
    sandbox.window = sandbox;
    vm.createContext(sandbox);

    const flag = LANDING_SRC.match(/^let bootBeaconSent = false;$/m);
    assert.ok(flag, 'the once-per-load flag must be declared in landing.js');
    vm.runInContext([
      flag[0],
      liftFunction(LANDING_SRC, 'async function readSwCacheName()'),
      liftFunction(LANDING_SRC, 'async function sendBootBeacon()'),
      liftFunction(LANDING_SRC, 'async function loadProjects()'),
      'globalThis.loadProjects = loadProjects;',
      'globalThis.sendBootBeacon = sendBootBeacon;'
    ].join('\n'), sandbox);

    sandbox.marks = marks;
    sandbox.calls = calls;
    sandbox.errors = errors;
    return sandbox;
  }

  /** Let the un-awaited beacon (its own two awaits) settle. */
  const settle = () => new Promise((r) => setImmediate(r));

  it('sends nothing while the projects fetch fails — a shell that has not rendered has not booted', async () => {
    const ctx = loadShell({ cacheKeys: ['tangleclaw-v3-60'] });
    ctx.serverUp = false;
    await ctx.loadProjects();
    await ctx.loadProjects();
    await settle();
    assert.equal(ctx.calls.length, 0);
    assert.deepEqual(ctx.marks, [], 'nothing rendered, nothing claimed');
  });

  it('sends exactly one beacon after the first success, carrying the cache generation and worker state', async () => {
    const ctx = loadShell({ cacheKeys: ['tangleclaw-v3-60', 'unrelated-cache'], controlled: true });
    await ctx.loadProjects();
    await settle();
    assert.equal(ctx.calls.length, 1);
    const [{ url, init }] = ctx.calls;
    assert.equal(url, '/api/dashboard/boot');
    assert.equal(init.method, 'POST');
    assert.equal(init.headers['Content-Type'], 'application/json',
      'the /api/ form-body rule refuses anything else');
    assert.deepEqual(JSON.parse(init.body), { cacheName: 'tangleclaw-v3-60', controlled: true },
      'only the TangleClaw generation is reported; the other cache is not ours');

    // The 10s poll and the reconnect probe both call loadProjects again.
    await ctx.loadProjects();
    await ctx.loadProjects();
    await settle();
    assert.equal(ctx.calls.length, 1, 'once per page load, not once per poll');
  });

  it('fires after the shell has rendered, never before', async () => {
    // Pinned on the lifted body's TEXT, not on runtime order: the beacon's
    // fetch sits behind two awaits, so a call moved ABOVE renderProjects()
    // still reaches `fetch` after the synchronous renders and the runtime
    // marks stay in the "right" order — a check that passes for the wrong
    // reason (Critic, #817). The source position is the fact.
    const body = liftFunction(LANDING_SRC, 'async function loadProjects()');
    const rendered = body.indexOf('renderProjects();');
    const call = body.indexOf('sendBootBeacon();');
    assert.notEqual(rendered, -1);
    assert.notEqual(call, -1);
    assert.ok(call > rendered, 'sendBootBeacon() must be written after renderProjects() in loadProjects');

    // And the beacon does go out on that path.
    const ctx = loadShell({ cacheKeys: ['tangleclaw-v3-60'] });
    await ctx.loadProjects();
    await settle();
    assert.ok(ctx.marks.includes('renderProjects') && ctx.marks.includes('beacon'), String(ctx.marks));
  });

  it('a refused beacon names the status in the console — from the log it looks like a shell that never ran', async () => {
    // 403 for an unserved Host, 415 for a non-JSON body, 404 before the server
    // restarts into this route: each returns before the access-log line.
    const ctx = loadShell({ cacheKeys: ['tangleclaw-v3-60'], fetchStatus: 404 });
    await ctx.loadProjects();
    await settle();
    assert.equal(ctx.calls.length, 1);
    assert.ok(ctx.errors.some((e) => e === 'boot beacon refused: HTTP 404'), ctx.errors.join('\n'));
  });

  it('a first success on a later poll still counts as the boot — the wizard path defers the first fetch', async () => {
    const ctx = loadShell({ cacheKeys: ['tangleclaw-v3-60'] });
    ctx.serverUp = false;
    await ctx.loadProjects();
    ctx.serverUp = true;
    await ctx.loadProjects();
    await settle();
    assert.equal(ctx.calls.length, 1);
  });

  it('a browser without Cache Storage or a controlling worker reports null and false rather than guessing', async () => {
    const ctx = loadShell({ cacheKeys: null, controlled: false });
    await ctx.loadProjects();
    await settle();
    assert.deepEqual(JSON.parse(ctx.calls[0].init.body), { cacheName: null, controlled: false });
  });

  it('a cache with no tangleclaw generation reports null, not an empty string', async () => {
    const ctx = loadShell({ cacheKeys: ['somebody-elses-cache'] });
    await ctx.loadProjects();
    await settle();
    assert.equal(JSON.parse(ctx.calls[0].init.body).cacheName, null);
  });

  it('a failed beacon is a console line, not a thrown error or a connection-state change', async () => {
    const ctx = loadShell({ cacheKeys: ['tangleclaw-v3-60'], fetchFails: true });
    await ctx.loadProjects();
    await settle();
    assert.equal(ctx.calls.length, 1);
    assert.ok(ctx.errors.some((e) => e.includes('boot beacon failed')), ctx.errors.join('\n'));
    assert.ok(ctx.marks.includes('updateUnregisteredToggle'), 'the render completed regardless');
  });

  it('the only call site is inside loadProjects, after the empty-answer guard', () => {
    // The property the whole feature rests on: nothing else — not init(), not
    // a poll — can say "booted". One producer, behind the fetch that proves it.
    const body = liftFunction(LANDING_SRC, 'async function loadProjects()');
    const callSites = LANDING_SRC.split('sendBootBeacon();').length - 1;
    assert.equal(callSites, 1, 'exactly one call site');
    const guard = body.indexOf('if (!data) return;');
    const call = body.indexOf('sendBootBeacon();');
    assert.notEqual(guard, -1);
    assert.ok(call > guard, 'the call sits after the guard that proves the fetch succeeded');
  });
});
