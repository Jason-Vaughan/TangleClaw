'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const ex = require('../lib/soak/executors');
const sched = require('../lib/soak/schedule');

/**
 * A fetch stand-in that records each request and answers from a script.
 * @param {(req: {method: string, path: string, body: *}) => ({status: number, body?: *, text?: string}|Error)} answer - Response per request; an Error is thrown as a fetch failure
 * @returns {{fetch: Function, calls: object[]}} The fake and its log
 */
function fakeFetch(answer) {
  const calls = [];
  const fetch = async (url, init) => {
    const req = {
      method: init.method,
      path: url.pathname,
      body: init.body === undefined ? undefined : JSON.parse(init.body),
      headers: init.headers
    };
    calls.push(req);
    const r = answer(req);
    if (r instanceof Error) throw r;
    const text = r.text !== undefined ? r.text : (r.body === undefined ? '' : JSON.stringify(r.body));
    return { status: r.status, text: async () => text };
  };
  return { fetch, calls };
}

/**
 * A call context for tests.
 * @param {Function} fetch - Fetch implementation
 * @param {object} [over] - Overrides
 * @returns {object} Context
 */
function ctx(fetch, over = {}) {
  return { apiBase: 'http://soak-guest.invalid:3102', token: null, fetch, ...over };
}

describe('soak executors — coverage of the catalogue', () => {
  it('has an executor for every api and engine kind, and none for browser or fault kinds', () => {
    for (const t of sched.TASKS) {
      const has = typeof ex.EXECUTORS[t.kind] === 'function';
      assert.equal(has, t.class === 'api' || t.class === 'engine', t.kind);
    }
    for (const f of sched.FAULTS) assert.equal(ex.EXECUTORS[f.kind], undefined, f.kind);
  });

  it('names no kind the schedule does not know', () => {
    const known = new Set([...sched.TASKS, ...sched.FAULTS].map((k) => k.kind));
    for (const kind of Object.keys(ex.EXECUTORS)) assert.ok(known.has(kind), kind);
  });
});

describe('soak executors — single calls', () => {
  it('reports OK for a 2xx and sends the bearer token when one is given', async () => {
    const f = fakeFetch(() => ({ status: 200, body: { ok: true } }));
    const r = await ex.EXECUTORS['api.health'](ctx(f.fetch, { token: 't0k' }), {});
    assert.deepEqual(r, { ok: true, code: 'OK', status: 200, step: null, steps: 1 });
    assert.equal(f.calls[0].method, 'GET');
    assert.equal(f.calls[0].path, '/api/health');
    assert.equal(f.calls[0].headers.authorization, 'Bearer t0k');
  });

  it('sends no authorization header without a token', async () => {
    const f = fakeFetch(() => ({ status: 200, body: {} }));
    await ex.EXECUTORS['api.projects.list'](ctx(f.fetch), {});
    assert.equal(f.calls[0].headers.authorization, undefined);
  });

  for (const status of [301, 302, 303, 307, 308]) {
    it(`refuses a ${status} redirect without following it, and records where it pointed`, async () => {
      const calls = [];
      const fetch = async (url, init) => {
        calls.push({ url: url.href, redirect: init.redirect });
        return { status, headers: { get: (h) => (h === 'location' ? 'http://localhost:3102/api/ports/lease' : null) }, text: async () => { throw new Error('the body of a refused redirect is never read'); } };
      };
      const r = await ex.EXECUTORS['api.ports.lease-release'](ctx(fetch), { port: 5512 });
      assert.deepEqual([r.ok, r.code, r.status, r.step, r.location], [false, 'REDIRECT_REFUSED', status, 0, 'http://localhost:3102/api/ports/lease']);
      assert.equal(calls.length, 1, 'nothing after the refused redirect, and no release');
      assert.equal(calls[0].redirect, 'manual');
    });
  }

  it('asks fetch never to follow redirects, on every call an executor makes', async () => {
    const modes = [];
    const fetch = async (url, init) => { modes.push(init.redirect); return { status: 200, text: async () => JSON.stringify({ active: false }) }; };
    for (const [kind, params] of [['api.health', {}], ['api.ports.lease-release', { port: 5512 }], ['engine.session.cycle', { project: 'soak-a', commands: 2 }]]) {
      await ex.EXECUTORS[kind](ctx(fetch), params);
    }
    assert.ok(modes.length >= 7);
    assert.ok(modes.every((m) => m === 'manual'), JSON.stringify(modes));
  });

  it('asks fetch never to follow redirects, and bounds every call, in the plans, switchboard and wrap kinds too', async () => {
    const seen = [];
    const fetch = async (url, init) => {
      seen.push([url.pathname, init.redirect, init.signal instanceof AbortSignal]);
      return { status: 200, text: async () => JSON.stringify({ active: false }) };
    };
    for (const [kind, params] of [['api.plans.read', { project: 'soak-a' }], ['api.medusa.reads', {}], ['engine.session.medusa-cycle', { from: 'soak-a', to: 'soak-b' }], ['engine.session.wrap-cycle', { project: 'soak-a' }]]) {
      await ex.EXECUTORS[kind](ctx(fetch, fakeClock()), params);
    }
    assert.ok(seen.length >= 8);
    assert.ok(seen.every(([, mode, bounded]) => mode === 'manual' && bounded), JSON.stringify(seen));
  });

  it('reports HTTP_STATUS with the status for a non-2xx', async () => {
    const f = fakeFetch(() => ({ status: 503, body: { error: 'down' } }));
    const r = await ex.EXECUTORS['api.ports.list'](ctx(f.fetch), {});
    assert.equal(r.ok, false);
    assert.equal(r.code, 'HTTP_STATUS');
    assert.equal(r.status, 503);
  });

  it('reports TIMEOUT when the request is aborted by its time budget', async () => {
    const err = new Error('timed out');
    err.name = 'TimeoutError';
    const r = await ex.EXECUTORS['api.health'](ctx(fakeFetch(() => err).fetch), {});
    assert.equal(r.code, 'TIMEOUT');
    assert.equal(r.status, null);
  });

  it('reports NETWORK when the connection fails', async () => {
    const r = await ex.EXECUTORS['api.server-info'](ctx(fakeFetch(() => new TypeError('fetch failed')).fetch), {});
    assert.equal(r.code, 'NETWORK');
  });

  it('reports BAD_BODY for a response that is not JSON', async () => {
    const r = await ex.EXECUTORS['api.health'](ctx(fakeFetch(() => ({ status: 200, text: '<html>' })).fetch), {});
    assert.equal(r.code, 'BAD_BODY');
    assert.equal(r.status, 200);
  });

  it('actually times out a hung request with the real AbortSignal', async () => {
    const hung = (url, init) => new Promise((_resolve, reject) => {
      init.signal.addEventListener('abort', () => reject(init.signal.reason));
    });
    // AbortSignal.timeout's timer is unref'd; a real fetch holds the loop open
    // with its socket, so the fake holds it open with a timer instead.
    const keepAlive = setTimeout(() => {}, 5000);
    try {
      const r = await ex.call(ctx(hung, { timeoutMs: 20 }), 'GET', '/api/health');
      assert.equal(r.code, 'TIMEOUT');
    } finally {
      clearTimeout(keepAlive);
    }
  });
});

describe('soak executors — port lease and release', () => {
  it('leases then releases the scheduled port under the soak project', async () => {
    const f = fakeFetch(() => ({ status: 201, body: {} }));
    const r = await ex.EXECUTORS['api.ports.lease-release'](ctx(f.fetch), { port: 5512 });
    assert.equal(r.ok, true);
    assert.deepEqual(f.calls.map((c) => `${c.method} ${c.path}`), ['POST /api/ports/lease', 'POST /api/ports/release']);
    assert.equal(f.calls[0].body.port, 5512);
    assert.equal(f.calls[0].body.project, ex.LEASE_PROJECT);
    assert.equal(f.calls[0].body.permanent, false);
    assert.equal(f.calls[1].body.project, ex.LEASE_PROJECT);
  });

  it('does not release a port whose lease was refused', async () => {
    const f = fakeFetch(() => ({ status: 409, body: { code: 'PORT_CONFLICT' } }));
    const r = await ex.EXECUTORS['api.ports.lease-release'](ctx(f.fetch), { port: 5512 });
    assert.deepEqual({ ok: r.ok, code: r.code, status: r.status, step: r.step }, { ok: false, code: 'HTTP_STATUS', status: 409, step: 0 });
    assert.equal(f.calls.length, 1);
  });
});

describe('soak executors — engine session cycle', () => {
  /**
   * A fetch for a cycle: the status route answers `status`, and every other
   * request answers `rest(req)`.
   * @param {{status: number, body?: object}} status - Answer to GET …/status
   * @param {(req: object) => object} [rest] - Answer for everything else
   * @returns {{fetch: Function, calls: object[]}} Fake
   */
  function cycleFetch(status, rest = () => ({ status: 200, body: {} })) {
    return fakeFetch((req) => (req.method === 'GET' && req.path.endsWith('/status') ? status : rest(req)));
  }
  const IDLE = { status: 200, body: { active: false, project: 'soak-a' } };
  const OURS = { status: 200, body: { active: true, engine: 'soak-stub' } };

  it('checks status, launches with the stub engine, injects each command, then kills the session', async () => {
    const f = cycleFetch(IDLE);
    const r = await ex.EXECUTORS['engine.session.cycle'](ctx(f.fetch), { project: 'soak a', commands: 2 });
    assert.deepEqual(r, { ok: true, code: 'OK', status: null, step: null, steps: 4 });
    assert.deepEqual(f.calls.map((c) => `${c.method} ${c.path}`), [
      'GET /api/sessions/soak%20a/status',
      'POST /api/sessions/soak%20a',
      'POST /api/sessions/soak%20a/command',
      'POST /api/sessions/soak%20a/command',
      'DELETE /api/sessions/soak%20a'
    ]);
    assert.equal(f.calls[1].body.engineOverride, ex.STUB_ENGINE_ID);
    assert.equal(f.calls[1].body.primePrompt, false);
  });

  it('kills a leftover soak-stub session first, as a cycle torn by a crash leaves, and reports it', async () => {
    const f = cycleFetch(OURS);
    const r = await ex.EXECUTORS['engine.session.cycle'](ctx(f.fetch), { project: 'soak-a', commands: 1 });
    assert.equal(r.ok, true);
    assert.equal(r.preKilled, true);
    assert.deepEqual(f.calls.map((c) => c.method), ['GET', 'DELETE', 'POST', 'POST', 'DELETE']);
  });

  it('never touches a session on any other engine, and launches nothing', async () => {
    for (const engine of ['claude', 'codex', undefined]) {
      const f = cycleFetch({ status: 200, body: { active: true, engine } });
      const r = await ex.EXECUTORS['engine.session.cycle'](ctx(f.fetch), { project: 'soak-a', commands: 1 });
      assert.deepEqual([r.ok, r.code, r.step, r.foreignEngine], [false, 'FOREIGN_SESSION', 'status', engine === undefined ? null : engine], String(engine));
      assert.deepEqual(f.calls.map((c) => c.method), ['GET'], 'only the status read');
    }
  });

  it('kills nothing and launches nothing when the status cannot be read', async () => {
    const f = cycleFetch({ status: 503, body: {} });
    const r = await ex.EXECUTORS['engine.session.cycle'](ctx(f.fetch), { project: 'soak-a', commands: 1 });
    assert.deepEqual([r.ok, r.code, r.status, r.step], [false, 'HTTP_STATUS', 503, 'status']);
    assert.equal(f.calls.length, 1);
  });

  it('stops before launching when the leftover kill fails, and treats a 404 there as already gone', async () => {
    const failed = cycleFetch(OURS, (req) => (req.method === 'DELETE' ? { status: 500, body: {} } : { status: 200, body: {} }));
    const r = await ex.EXECUTORS['engine.session.cycle'](ctx(failed.fetch), { project: 'soak-a', commands: 1 });
    assert.deepEqual([r.ok, r.step, r.status], [false, 'pre-kill', 500]);
    assert.deepEqual(failed.calls.map((c) => c.method), ['GET', 'DELETE']);

    let deletes = 0;
    const gone = cycleFetch(OURS, (req) => (req.method === 'DELETE' && deletes++ === 0 ? { status: 404, body: {} } : { status: 200, body: {} }));
    const r2 = await ex.EXECUTORS['engine.session.cycle'](ctx(gone.fetch), { project: 'soak-a', commands: 1 });
    assert.equal(r2.ok, true);
    assert.equal(r2.preKilled, undefined);
  });

  it('stops without a kill when the launch fails', async () => {
    const f = cycleFetch(IDLE, () => ({ status: 404, body: {} }));
    const r = await ex.EXECUTORS['engine.session.cycle'](ctx(f.fetch), { project: 'soak-a', commands: 3 });
    assert.equal(r.step, 0);
    assert.deepEqual(f.calls.map((c) => c.method), ['GET', 'POST']);
  });

  it('still kills the session when a command fails, and reports the failing command', async () => {
    const f = cycleFetch(IDLE, (req) => (req.path.endsWith('/command') && req.body.command === 'soak ping 2' ? { status: 500, body: {} } : { status: 200, body: {} }));
    const r = await ex.EXECUTORS['engine.session.cycle'](ctx(f.fetch), { project: 'soak-a', commands: 3 });
    assert.deepEqual(r, { ok: false, code: 'HTTP_STATUS', status: 500, step: 2, steps: 5, cleanupFailed: false });
    assert.equal(f.calls[f.calls.length - 1].method, 'DELETE');
    assert.equal(f.calls.filter((c) => c.path.endsWith('/command')).length, 2, 'no command after the failed one');
  });

  it('records a failed kill after a failed command as cleanupFailed', async () => {
    const f = cycleFetch(IDLE, (req) => (req.method === 'POST' && !req.path.endsWith('/command') ? { status: 200, body: {} } : { status: 500, body: {} }));
    const r = await ex.EXECUTORS['engine.session.cycle'](ctx(f.fetch), { project: 'soak-a', commands: 1 });
    assert.equal(r.step, 1);
    assert.equal(r.cleanupFailed, true);
  });

  it('reports a failed kill after a clean cycle at the kill step', async () => {
    const f = cycleFetch(IDLE, (req) => (req.method === 'DELETE' ? { status: 500, body: {} } : { status: 200, body: {} }));
    const r = await ex.EXECUTORS['engine.session.cycle'](ctx(f.fetch), { project: 'soak-a', commands: 1 });
    assert.deepEqual({ ok: r.ok, step: r.step, steps: r.steps }, { ok: false, step: 2, steps: 3 });
  });
});

/**
 * A clock whose sleep advances time instantly, so a poll budget runs out in
 * no real time.
 * @returns {{now: () => number, sleep: (ms: number) => Promise<void>, slept: number[]}} Clock
 */
function fakeClock() {
  let t = 1_000_000;
  const slept = [];
  return { now: () => t, sleep: async (ms) => { slept.push(ms); t += ms; }, slept };
}

describe('soak executors — plans read', () => {
  const LIST = { status: 200, body: { plans: [{ file: 'other.md', urlPath: '/plans/7/other.md' }, { file: ex.PLAN_FILE, urlPath: `/plans/7/${ex.PLAN_FILE}` }] } };

  it('lists the project\'s plans, then reads the soak plan\'s page, keeping only status and length', async () => {
    const f = fakeFetch((req) => (req.path.startsWith('/api/') ? LIST : { status: 200, text: '<html>plan</html>' }));
    const r = await ex.EXECUTORS['api.plans.read'](ctx(f.fetch, { token: 't0k' }), { project: 'soak a' });
    assert.deepEqual(r, { ok: true, code: 'OK', status: 200, step: null, steps: 2, bytes: 17 });
    assert.deepEqual(f.calls.map((c) => `${c.method} ${c.path}`), ['GET /api/projects/soak%20a/plans', `GET /plans/7/${ex.PLAN_FILE}`]);
    assert.equal(f.calls[1].headers.authorization, 'Bearer t0k');
    assert.equal(ex.PLAN_FILE, 'soak-plan.md');
  });

  it('reports NOT_LISTED, and reads no page, when the listing lacks the soak plan', async () => {
    const f = fakeFetch(() => ({ status: 200, body: { plans: [{ file: 'other.md', urlPath: '/plans/7/other.md' }] } }));
    const r = await ex.EXECUTORS['api.plans.read'](ctx(f.fetch), { project: 'soak-a' });
    assert.deepEqual([r.ok, r.code, r.step], [false, 'NOT_LISTED', 0]);
    assert.equal(f.calls.length, 1);
  });

  it('reports BAD_BODY for a listing with no plans array', async () => {
    const r = await ex.EXECUTORS['api.plans.read'](ctx(fakeFetch(() => ({ status: 200, body: { plans: null } })).fetch), { project: 'soak-a' });
    assert.deepEqual([r.ok, r.code, r.step], [false, 'BAD_BODY', 0]);
  });

  it('reports a failed listing at step 0', async () => {
    const r = await ex.EXECUTORS['api.plans.read'](ctx(fakeFetch(() => ({ status: 404, body: {} })).fetch), { project: 'soak-a' });
    assert.deepEqual([r.ok, r.code, r.status, r.step], [false, 'HTTP_STATUS', 404, 0]);
  });

  it('reports a page that is not 200 at step 1, with its length', async () => {
    const f = fakeFetch((req) => (req.path.startsWith('/api/') ? LIST : { status: 204, text: '' }));
    const r = await ex.EXECUTORS['api.plans.read'](ctx(f.fetch), { project: 'soak-a' });
    assert.deepEqual(r, { ok: false, code: 'HTTP_STATUS', status: 204, step: 1, steps: 2, bytes: 0 });
  });

  it('refuses a redirect from the page without following it', async () => {
    const calls = [];
    const fetch = async (url, init) => {
      calls.push({ path: url.pathname, redirect: init.redirect, signal: init.signal });
      if (url.pathname.startsWith('/api/')) return { status: 200, text: async () => JSON.stringify(LIST.body) };
      return { status: 302, headers: { get: () => 'http://localhost:3102/' }, text: async () => { throw new Error('never read'); } };
    };
    const r = await ex.EXECUTORS['api.plans.read'](ctx(fetch), { project: 'soak-a' });
    assert.deepEqual([r.ok, r.code, r.status, r.step, r.location], [false, 'REDIRECT_REFUSED', 302, 1, 'http://localhost:3102/']);
    assert.ok(calls.every((c) => c.redirect === 'manual' && c.signal));
  });

  it('never requests a plan link that resolves off the soak target', async () => {
    for (const urlPath of ['http://127.0.0.1:3102/plans/7/soak-plan.md', '//evil.invalid/plans', '/\\evil.invalid/plans', 42, null]) {
      const f = fakeFetch(() => ({ status: 200, body: { plans: [{ file: ex.PLAN_FILE, urlPath }] } }));
      const r = await ex.EXECUTORS['api.plans.read'](ctx(f.fetch), { project: 'soak-a' });
      assert.deepEqual([r.ok, r.code, r.step], [false, 'FOREIGN_LINK', 1], String(urlPath));
      assert.equal(f.calls.length, 1, `only the listing, for ${urlPath}`);
    }
  });
});

describe('soak executors — switchboard reads', () => {
  it('reads deliveries, then escalations', async () => {
    const f = fakeFetch(() => ({ status: 200, body: {} }));
    const r = await ex.EXECUTORS['api.medusa.reads'](ctx(f.fetch), {});
    assert.deepEqual(r, { ok: true, code: 'OK', status: null, step: null, steps: 2 });
    assert.deepEqual(f.calls.map((c) => `${c.method} ${c.path}`), ['GET /api/medusa/deliveries', 'GET /api/medusa/escalations']);
  });

  it('stops at a failed deliveries read', async () => {
    const f = fakeFetch(() => ({ status: 500, body: {} }));
    const r = await ex.EXECUTORS['api.medusa.reads'](ctx(f.fetch), {});
    assert.deepEqual([r.ok, r.code, r.step], [false, 'HTTP_STATUS', 0]);
    assert.equal(f.calls.length, 1);
  });
});

describe('soak executors — switchboard cycle', () => {
  const PAIR = { from: 'soak-a', to: 'soak-b' };
  const WS = { 'soak-a': 'ws-a', 'soak-b': 'ws-b' };

  /**
   * A fake TangleClaw for a switchboard cycle. Each route can be overridden.
   * @param {object} [over] - `{status(project), launch(project), medusaStatus(project, n), send, messages(n), read, kill(project)}`
   * @returns {{fetch: Function, calls: object[]}} Fake
   */
  function medusaFetch(over = {}) {
    const polls = {};
    let inboxReads = 0;
    const o = {
      status: () => ({ status: 200, body: { active: false } }),
      launch: () => ({ status: 200, body: {} }),
      medusaStatus: (p) => ({ status: 200, body: { state: 'listening', workspaceId: WS[p] } }),
      send: () => ({ status: 200, body: { id: 'msg-1' } }),
      messages: () => ({ status: 200, body: { messages: [{ id: 'msg-0' }, { id: 'msg-1' }] } }),
      read: () => ({ status: 200, body: {} }),
      kill: () => ({ status: 200, body: {} }),
      ...over
    };
    return fakeFetch((req) => {
      const m = req.path.match(/^\/api\/sessions\/([^/]+)(\/.*)?$/);
      const project = decodeURIComponent(m[1]);
      const rest = m[2] || '';
      if (req.method === 'GET' && rest === '/status') return o.status(project);
      if (req.method === 'POST' && rest === '') return o.launch(project);
      if (req.method === 'DELETE' && rest === '') return o.kill(project);
      if (rest === '/medusa/status') { polls[project] = (polls[project] || 0) + 1; return o.medusaStatus(project, polls[project]); }
      if (rest === '/medusa/send') return o.send(req);
      if (rest === '/medusa/messages') return o.messages(++inboxReads);
      if (rest === '/medusa/read') return o.read(req);
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
  }
  const route = (c) => `${c.method} ${c.path}`;

  it('guards both, launches both, waits for listeners, sends, sees delivery, marks it read, and kills both', async () => {
    const clock = fakeClock();
    let n = 0;
    const f = medusaFetch({ medusaStatus: (p) => ({ status: 200, body: { state: ++n <= 3 ? 'connecting' : 'listening', workspaceId: WS[p] } }) });
    const runKey = `${'c'.repeat(16)}-1790000000000`;
    const r = await ex.EXECUTORS['engine.session.medusa-cycle'](ctx(f.fetch, { ...clock, eventIndex: 41, runKey }), PAIR);
    assert.deepEqual(r, { ok: true, code: 'OK', status: null, step: null, steps: 7, messageId: 'msg-1' });
    const seq = f.calls.map(route);
    assert.deepEqual(seq.slice(0, 4), ['GET /api/sessions/soak-a/status', 'GET /api/sessions/soak-b/status', 'POST /api/sessions/soak-a', 'POST /api/sessions/soak-b']);
    assert.deepEqual(seq.slice(-5), ['POST /api/sessions/soak-a/medusa/send', 'GET /api/sessions/soak-b/medusa/messages', 'POST /api/sessions/soak-b/medusa/read', 'DELETE /api/sessions/soak-a', 'DELETE /api/sessions/soak-b']);
    for (const launch of f.calls.filter((c) => c.method === 'POST' && /^\/api\/sessions\/[^/]+$/.test(c.path))) {
      assert.deepEqual(launch.body, { engineOverride: ex.STUB_ENGINE_ID, primePrompt: false });
    }
    const send = f.calls.find((c) => c.path.endsWith('/medusa/send'));
    assert.deepEqual(Object.keys(send.body).sort(), ['message', 'requestId', 'to']);
    assert.equal(send.body.to, 'ws-b', 'the recipient\'s workspace, from its own status');
    assert.equal(send.body.requestId, `soak-medusa-${runKey}-41`, 'scoped to the run, since the server keeps request ids unique across all sends');
    assert.match(send.body.message, /event 41/);
    assert.deepEqual(f.calls.find((c) => c.path.endsWith('/medusa/read')).body, { ids: ['msg-1'] });
    assert.ok(clock.slept.length > 0, 'the listener wait used the injected sleep');
  });

  it('sends the same body on a rerun of the same event in the same run, and no request id without an event index and run key', async () => {
    const bodies = [];
    const runKey = `${'d'.repeat(16)}-1790000000001`;
    for (const extra of [{ eventIndex: 3, runKey }, { eventIndex: 3, runKey }, {}, { eventIndex: 3 }]) {
      const f = medusaFetch();
      await ex.EXECUTORS['engine.session.medusa-cycle'](ctx(f.fetch, { ...fakeClock(), ...extra }), PAIR);
      bodies.push(f.calls.find((c) => c.path.endsWith('/medusa/send')).body);
    }
    assert.deepEqual(bodies[0], bodies[1]);
    assert.equal(bodies[0].requestId, `soak-medusa-${runKey}-3`);
    assert.equal(bodies[2].requestId, undefined);
    assert.equal(bodies[3].requestId, undefined, 'an unscoped id could collide with another run\'s');
    assert.equal(bodies[2].inReplyTo, undefined);
    assert.equal(bodies[2].priority, undefined);
  });

  for (const which of ['soak-a', 'soak-b']) {
    it(`never touches a foreign session on ${which}, and launches nothing`, async () => {
      const f = medusaFetch({ status: (p) => ({ status: 200, body: p === which ? { active: true, engine: 'claude' } : { active: false } }) });
      const r = await ex.EXECUTORS['engine.session.medusa-cycle'](ctx(f.fetch, fakeClock()), PAIR);
      assert.deepEqual([r.ok, r.code, r.step, r.project, r.foreignEngine], [false, 'FOREIGN_SESSION', 'status', which, 'claude']);
      assert.ok(f.calls.every((c) => c.method === 'GET'), JSON.stringify(f.calls.map(route)));
    });

    it(`kills nothing when ${which}'s status cannot be read`, async () => {
      const f = medusaFetch({ status: (p) => (p === which ? { status: 503, body: {} } : { status: 200, body: { active: false } }) });
      const r = await ex.EXECUTORS['engine.session.medusa-cycle'](ctx(f.fetch, fakeClock()), PAIR);
      assert.deepEqual([r.ok, r.code, r.status, r.step, r.project], [false, 'HTTP_STATUS', 503, 'status', which]);
      assert.ok(f.calls.every((c) => c.method === 'GET'));
    });
  }

  it('clears leftover soak-stub sessions on both projects and reports them', async () => {
    const f = medusaFetch({ status: () => ({ status: 200, body: { active: true, engine: 'soak-stub' } }) });
    const r = await ex.EXECUTORS['engine.session.medusa-cycle'](ctx(f.fetch, fakeClock()), PAIR);
    assert.equal(r.ok, true);
    assert.deepEqual(r.preKilled, ['soak-a', 'soak-b']);
    assert.deepEqual(f.calls.slice(0, 4).map(route), ['GET /api/sessions/soak-a/status', 'DELETE /api/sessions/soak-a', 'GET /api/sessions/soak-b/status', 'DELETE /api/sessions/soak-b']);
  });

  it('kills nothing when the first launch fails', async () => {
    const f = medusaFetch({ launch: () => ({ status: 500, body: {} }) });
    const r = await ex.EXECUTORS['engine.session.medusa-cycle'](ctx(f.fetch, fakeClock()), PAIR);
    assert.deepEqual([r.ok, r.code, r.step, r.project], [false, 'HTTP_STATUS', 'launch', 'soak-a']);
    assert.equal(f.calls.some((c) => c.method === 'DELETE'), false);
  });

  it('kills both when the second launch fails, treating a 404 for the unlaunched one as clean', async () => {
    const f = medusaFetch({ launch: (p) => (p === 'soak-b' ? { status: 500, body: {} } : { status: 200, body: {} }), kill: (p) => (p === 'soak-b' ? { status: 404, body: {} } : { status: 200, body: {} }) });
    const r = await ex.EXECUTORS['engine.session.medusa-cycle'](ctx(f.fetch, fakeClock()), PAIR);
    assert.deepEqual([r.ok, r.code, r.step, r.project, r.cleanupFailed], [false, 'HTTP_STATUS', 'launch', 'soak-b', false]);
    assert.deepEqual(f.calls.filter((c) => c.method === 'DELETE').map(route), ['DELETE /api/sessions/soak-a', 'DELETE /api/sessions/soak-b']);
    assert.equal(f.calls.some((c) => c.path.includes('/medusa/')), false, 'no switchboard step after a failed launch');
  });

  it('reports NOT_LISTENING, naming the laggard, when the budget runs out, and still kills both', async () => {
    const clock = fakeClock();
    const f = medusaFetch({ medusaStatus: (p) => ({ status: 200, body: { state: p === 'soak-b' ? 'reconnecting' : 'listening', workspaceId: WS[p] } }) });
    const r = await ex.EXECUTORS['engine.session.medusa-cycle'](ctx(f.fetch, clock), PAIR);
    assert.deepEqual([r.ok, r.code, r.step, r.notListening, r.cleanupFailed], [false, 'NOT_LISTENING', 'listen', ['soak-b'], false]);
    assert.ok(clock.slept.reduce((a, b) => a + b, 0) >= ex.POLL.listenMs, 'the whole budget was spent');
    assert.ok(clock.slept.reduce((a, b) => a + b, 0) <= ex.POLL.listenMs, 'and not more');
    assert.equal(f.calls.filter((c) => c.path === '/api/sessions/soak-a/medusa/status').length, 1, 'a listening project is not read again');
    assert.deepEqual(f.calls.filter((c) => c.method === 'DELETE').length, 2);
    assert.equal(f.calls.some((c) => c.path.endsWith('/medusa/send')), false);
  });

  it('fails at the listen step when a switchboard status read fails, and still kills both', async () => {
    const f = medusaFetch({ medusaStatus: (p) => (p === 'soak-b' ? { status: 500, body: {} } : { status: 200, body: { state: 'listening', workspaceId: WS[p] } }) });
    const r = await ex.EXECUTORS['engine.session.medusa-cycle'](ctx(f.fetch, fakeClock()), PAIR);
    assert.deepEqual([r.ok, r.code, r.status, r.step, r.project, r.cleanupFailed], [false, 'HTTP_STATUS', 500, 'listen', 'soak-b', false]);
    assert.equal(f.calls.filter((c) => c.method === 'DELETE').length, 2);
  });

  it('reports BAD_BODY when the recipient listens without a workspace id', async () => {
    const f = medusaFetch({ medusaStatus: () => ({ status: 200, body: { state: 'listening' } }) });
    const r = await ex.EXECUTORS['engine.session.medusa-cycle'](ctx(f.fetch, fakeClock()), PAIR);
    assert.deepEqual([r.ok, r.code, r.step, r.project], [false, 'BAD_BODY', 'listen', 'soak-b']);
    assert.equal(f.calls.filter((c) => c.method === 'DELETE').length, 2);
  });

  it('reports a failed send, or one with no message id, and still kills both', async () => {
    for (const [send, code] of [[{ status: 403, body: {} }, 'HTTP_STATUS'], [{ status: 200, body: {} }, 'BAD_BODY']]) {
      const f = medusaFetch({ send: () => send });
      const r = await ex.EXECUTORS['engine.session.medusa-cycle'](ctx(f.fetch, fakeClock()), PAIR);
      assert.deepEqual([r.ok, r.code, r.step, r.project, r.cleanupFailed], [false, code, 'send', 'soak-a', false]);
      assert.equal(f.calls.filter((c) => c.method === 'DELETE').length, 2);
    }
  });

  it('waits for delivery, and reports NOT_DELIVERED when the budget runs out', async () => {
    const clock = fakeClock();
    const late = medusaFetch({ messages: (n) => ({ status: 200, body: { messages: n < 4 ? [{ id: 'msg-0' }] : [{ id: 'msg-1' }] } }) });
    assert.equal((await ex.EXECUTORS['engine.session.medusa-cycle'](ctx(late.fetch, clock), PAIR)).ok, true);
    assert.equal(late.calls.filter((c) => c.path.endsWith('/medusa/messages')).length, 4);

    const clock2 = fakeClock();
    const never = medusaFetch({ messages: () => ({ status: 200, body: { messages: [{ id: 'msg-0' }] } }) });
    const r = await ex.EXECUTORS['engine.session.medusa-cycle'](ctx(never.fetch, clock2), PAIR);
    assert.deepEqual([r.ok, r.code, r.step, r.project, r.cleanupFailed], [false, 'NOT_DELIVERED', 'deliver', 'soak-b', false]);
    assert.ok(clock2.slept.reduce((a, b) => a + b, 0) >= ex.POLL.deliveryMs);
    assert.equal(never.calls.some((c) => c.path.endsWith('/medusa/read')), false, 'nothing is marked read that never arrived');
    assert.equal(never.calls.filter((c) => c.method === 'DELETE').length, 2);
  });

  it('fails at the deliver step when the inbox cannot be read', async () => {
    const f = medusaFetch({ messages: () => ({ status: 502, body: {} }) });
    const r = await ex.EXECUTORS['engine.session.medusa-cycle'](ctx(f.fetch, fakeClock()), PAIR);
    assert.deepEqual([r.ok, r.code, r.status, r.step], [false, 'HTTP_STATUS', 502, 'deliver']);
  });

  it('reports a failed mark-read, and still kills both', async () => {
    const f = medusaFetch({ read: () => ({ status: 500, body: {} }) });
    const r = await ex.EXECUTORS['engine.session.medusa-cycle'](ctx(f.fetch, fakeClock()), PAIR);
    assert.deepEqual([r.ok, r.code, r.step, r.project, r.cleanupFailed], [false, 'HTTP_STATUS', 'read', 'soak-b', false]);
    assert.equal(f.calls.filter((c) => c.method === 'DELETE').length, 2);
  });

  it('attempts both kills even when the first fails, and reports the failure', async () => {
    const f = medusaFetch({ kill: (p) => (p === 'soak-a' ? { status: 500, body: {} } : { status: 200, body: {} }) });
    const r = await ex.EXECUTORS['engine.session.medusa-cycle'](ctx(f.fetch, fakeClock()), PAIR);
    assert.deepEqual([r.ok, r.code, r.status, r.step, r.project], [false, 'HTTP_STATUS', 500, 'kill', 'soak-a']);
    assert.equal(f.calls.filter((c) => c.method === 'DELETE').length, 2);

    const g = medusaFetch({ read: () => ({ status: 500, body: {} }), kill: (p) => (p === 'soak-b' ? { status: 500, body: {} } : { status: 200, body: {} }) });
    const r2 = await ex.EXECUTORS['engine.session.medusa-cycle'](ctx(g.fetch, fakeClock()), PAIR);
    assert.deepEqual([r2.step, r2.cleanupFailed], ['read', true]);
  });
});

describe('soak executors — wrap cycle', () => {
  const RUN = 'run-7';
  const DONE = { runId: RUN, stale: false, finishedAt: 5, result: { ok: true, status: 'wrapping', sessionOutcome: 'ended', pipelineResult: { ok: true } } };

  /**
   * A fake TangleClaw for a wrap cycle.
   * @param {object} [over] - `{status, launch, wrap, wrapStatus(n), kill}`
   * @returns {{fetch: Function, calls: object[]}} Fake
   */
  function wrapFetch(over = {}) {
    let polls = 0;
    const o = {
      status: () => ({ status: 200, body: { active: false } }),
      launch: () => ({ status: 200, body: {} }),
      wrap: () => ({ status: 202, body: { ok: true, runId: RUN, status: 'wrapping' } }),
      wrapStatus: () => ({ status: 200, body: DONE }),
      kill: () => ({ status: 200, body: {} }),
      ...over
    };
    return fakeFetch((req) => {
      const rest = req.path.replace(/^\/api\/sessions\/[^/]+/, '');
      if (req.method === 'GET' && rest === '/status') return o.status();
      if (req.method === 'POST' && rest === '') return o.launch();
      if (req.method === 'DELETE' && rest === '') return o.kill();
      if (req.method === 'POST' && rest === '/wrap') return o.wrap(req);
      if (req.method === 'GET' && rest === '/wrap/status') return o.wrapStatus(++polls);
      throw new Error(`unexpected ${req.method} ${req.path}`);
    });
  }
  const run = (f, clock = fakeClock()) => ex.EXECUTORS['engine.session.wrap-cycle'](ctx(f.fetch, clock), { project: 'soak-a' });
  const deletes = (f) => f.calls.filter((c) => c.method === 'DELETE').length;

  it('launches, wraps with AI content skipped and the session ending, follows its run, and does not kill an ended session', async () => {
    const f = wrapFetch({ wrapStatus: (n) => ({ status: 200, body: n < 3 ? { runId: RUN, stale: false, finishedAt: null, result: null } : DONE }) });
    const r = await run(f);
    assert.deepEqual(r, { ok: true, code: 'OK', status: null, step: null, steps: 4, runId: RUN });
    assert.deepEqual(f.calls.map((c) => `${c.method} ${c.path}`).slice(0, 3), ['GET /api/sessions/soak-a/status', 'POST /api/sessions/soak-a', 'POST /api/sessions/soak-a/wrap']);
    assert.deepEqual(f.calls[1].body, { engineOverride: ex.STUB_ENGINE_ID, primePrompt: false });
    assert.deepEqual(f.calls[2].body, { options: { keepSessionRunning: false, skipAiContent: { 'changelog-update': true, 'release-recommendation': true, 'learnings-capture': true, 'memory-update': true } } });
    assert.equal(f.calls.filter((c) => c.path.endsWith('/wrap/status')).length, 3);
    assert.equal(deletes(f), 0);
  });

  it('ignores a finished status that names another run', async () => {
    const other = { ...DONE, runId: 'run-6' };
    const f = wrapFetch({ wrapStatus: (n) => ({ status: 200, body: n < 3 ? other : DONE }) });
    const r = await run(f);
    assert.equal(r.ok, true);
    assert.equal(f.calls.filter((c) => c.path.endsWith('/wrap/status')).length, 3);
  });

  it('never kills a foreign session, and kills nothing when the status is unreadable', async () => {
    const foreign = wrapFetch({ status: () => ({ status: 200, body: { active: true, engine: 'codex' } }) });
    const r = await run(foreign);
    assert.deepEqual([r.ok, r.code, r.step, r.foreignEngine], [false, 'FOREIGN_SESSION', 'status', 'codex']);
    assert.equal(foreign.calls.length, 1);
    const unreadable = wrapFetch({ status: () => ({ status: 500, body: {} }) });
    const r2 = await run(unreadable);
    assert.deepEqual([r2.code, r2.step], ['HTTP_STATUS', 'status']);
    assert.equal(unreadable.calls.length, 1);
  });

  it('stops without a wrap or a kill when the launch fails', async () => {
    const f = wrapFetch({ launch: () => ({ status: 404, body: {} }) });
    const r = await run(f);
    assert.deepEqual([r.ok, r.step], [false, 'launch']);
    assert.equal(f.calls.length, 2);
  });

  it('maps STRANDED_WRAPS to WRAP_STRANDED and kills the session it launched', async () => {
    const f = wrapFetch({ wrap: () => ({ status: 409, body: { code: 'STRANDED_WRAPS', items: [] } }) });
    const r = await run(f);
    assert.deepEqual([r.ok, r.code, r.status, r.step, r.cleanupFailed], [false, 'WRAP_STRANDED', 409, 'wrap', false]);
    assert.equal(deletes(f), 1);
  });

  it('never kills on WRAP_IN_PROGRESS, since another run owns the session', async () => {
    const f = wrapFetch({ wrap: () => ({ status: 409, body: { code: 'WRAP_IN_PROGRESS', runId: 'run-other' } }) });
    const r = await run(f);
    assert.deepEqual([r.ok, r.code, r.status, r.step, r.runId], [false, 'WRAP_IN_PROGRESS', 409, 'wrap', 'run-other']);
    assert.equal(deletes(f), 0);
  });

  it('reports any other refusal as HTTP_STATUS and kills the session', async () => {
    for (const wrap of [{ status: 409, body: { code: 'WRAP_KEEP_SETTING_INVALID' } }, { status: 503, body: { code: 'WRAP_DISABLED' } }]) {
      const f = wrapFetch({ wrap: () => wrap });
      const r = await run(f);
      assert.deepEqual([r.ok, r.code, r.status, r.step], [false, 'HTTP_STATUS', wrap.status, 'wrap']);
      assert.equal(deletes(f), 1);
    }
  });

  it('reports a 2xx that is not a 202 with a run id, and kills the session', async () => {
    for (const [wrap, code] of [[{ status: 200, body: { runId: RUN } }, 'HTTP_STATUS'], [{ status: 202, body: { ok: true } }, 'BAD_BODY']]) {
      const f = wrapFetch({ wrap: () => wrap });
      const r = await run(f);
      assert.deepEqual([r.ok, r.code, r.step], [false, code, 'wrap']);
      assert.equal(deletes(f), 1);
    }
  });

  it('reports WRAP_TIMEOUT when the run does not finish within the budget, and kills the session', async () => {
    const clock = fakeClock();
    const f = wrapFetch({ wrapStatus: () => ({ status: 200, body: { runId: RUN, stale: false, finishedAt: null } }) });
    const r = await run(f, clock);
    assert.deepEqual([r.ok, r.code, r.step, r.runId, r.cleanupFailed], [false, 'WRAP_TIMEOUT', 'wrap-status', RUN, false]);
    const waited = clock.slept.reduce((a, b) => a + b, 0);
    assert.ok(waited >= ex.POLL.wrapMs && waited <= ex.POLL.wrapMs, String(waited));
    assert.equal(deletes(f), 1);
  });

  it('reports WRAP_STALE for a run claimed and never settled, and kills the session', async () => {
    const f = wrapFetch({ wrapStatus: () => ({ status: 200, body: { runId: RUN, stale: true, finishedAt: null } }) });
    const r = await run(f);
    assert.deepEqual([r.ok, r.code], [false, 'WRAP_STALE']);
    assert.equal(f.calls.filter((c) => c.path.endsWith('/wrap/status')).length, 1);
    assert.equal(deletes(f), 1);
  });

  it('reports WRAP_BLOCKED with blockedAt, judging by the run\'s verdicts and never by result.status', async () => {
    const cases = [
      [{ ok: false, status: 'blocked', sessionOutcome: null, pipelineResult: { ok: false, blockedAt: 'commit' } }, 'commit'],
      [{ ok: true, status: 'wrapping', sessionOutcome: 'ended', pipelineResult: { ok: false } }, undefined],
      [{ ok: true, status: 'wrapping', sessionOutcome: 'ended' }, undefined]
    ];
    for (const [result, blockedAt] of cases) {
      const f = wrapFetch({ wrapStatus: () => ({ status: 200, body: { ...DONE, result } }) });
      const r = await run(f);
      assert.deepEqual([r.ok, r.code, r.blockedAt], [false, 'WRAP_BLOCKED', blockedAt], JSON.stringify(result));
      assert.equal(deletes(f), result.sessionOutcome === 'ended' ? 0 : 1, 'killed only when the run did not end the session');
    }
    const noResult = wrapFetch({ wrapStatus: () => ({ status: 200, body: { ...DONE, result: null } }) });
    assert.equal((await run(noResult)).code, 'WRAP_BLOCKED');
    assert.equal(deletes(noResult), 1);
  });

  it('reports WRAP_NOT_ENDED when a successful run kept the session, and kills it', async () => {
    const f = wrapFetch({ wrapStatus: () => ({ status: 200, body: { ...DONE, result: { ...DONE.result, sessionOutcome: 'kept' } } }) });
    const r = await run(f);
    assert.deepEqual([r.ok, r.code, r.cleanupFailed], [false, 'WRAP_NOT_ENDED', false]);
    assert.equal(deletes(f), 1);
  });

  it('fails at wrap-status when the status cannot be read, and records a failed kill', async () => {
    const f = wrapFetch({ wrapStatus: () => ({ status: 500, body: {} }), kill: () => ({ status: 500, body: {} }) });
    const r = await run(f);
    assert.deepEqual([r.ok, r.code, r.status, r.step, r.cleanupFailed], [false, 'HTTP_STATUS', 500, 'wrap-status', true]);
  });

  it('reports a leftover soak-stub session it cleared', async () => {
    const f = wrapFetch({ status: () => ({ status: 200, body: { active: true, engine: 'soak-stub' } }) });
    const r = await run(f);
    assert.deepEqual([r.ok, r.preKilled], [true, true]);
  });
});

describe('soak executors: switchboard request ids are scoped to the run (RM05 finding 2)', () => {
  it('names the run and event in the request id, and reads a server refusal of a re-send as its own outcome', async () => {
    const ex = require('../lib/soak/executors');
    const sends = [];
    const replies = {
      status: { ok: true, body: { active: false } },
      medusaStatus: { ok: true, body: { state: 'listening', workspaceId: 'soak-b-12345678' } }
    };
    /**
     * A target that refuses the send as already attempted.
     * @param {URL} url - Request URL
     * @param {object} init - Request init
     * @returns {Promise<object>} Response
     */
    const fetch = async (url, init) => {
      const p = new URL(url).pathname;
      const json = (status, body) => ({ status, headers: { get: () => null }, text: async () => JSON.stringify(body) });
      if (p.endsWith('/medusa/send')) {
        sends.push(JSON.parse(init.body));
        return json(409, { error: 'already attempted', code: 'SEND_ALREADY_ATTEMPTED' });
      }
      if (p.endsWith('/medusa/status')) return json(200, replies.medusaStatus.body);
      if (p.endsWith('/status')) return json(200, replies.status.body);
      return json(200, {});
    };
    const ctx = { apiBase: 'http://127.0.0.1:1', fetch, eventIndex: 7, runKey: `${'a'.repeat(16)}-1790000000000`, sleep: async () => {}, now: () => 0 };
    const out = await ex.EXECUTORS['engine.session.medusa-cycle'](ctx, { from: 'soak-a', to: 'soak-b' });
    assert.equal(sends[0].requestId, `soak-medusa-${'a'.repeat(16)}-1790000000000-7`);
    assert.equal(out.code, ex.OUTCOME.SEND_ALREADY_ATTEMPTED);
    assert.equal(out.step, 'send');
    assert.notEqual(out.code, ex.OUTCOME.HTTP_STATUS, 'never recorded as a failed send');
  });
});
