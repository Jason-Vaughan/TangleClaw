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
      query: url.searchParams,
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

const stubEngine = require('../deploy/soak/stub-engine/soak-stub');

/** Each fake session's launch binding, as TangleClaw would export it into its pane. */
const FLEET = Object.freeze({
  'soak-a': Object.freeze({ projectId: '11', launchId: 'launch-a-7f3e9c1d', workspaceId: 'ws-a' }),
  'soak-b': Object.freeze({ projectId: '12', launchId: 'launch-b-2b8d4a6e', workspaceId: 'ws-b' })
});
const API_ORIGIN = 'http://soak-guest.invalid:3102';

/**
 * The environment a fake session's pane holds.
 * @param {string} project - Project name
 * @returns {object} Env
 */
function paneEnv(project) {
  const id = FLEET[project];
  return { TANGLECLAW_API: API_ORIGIN, TANGLECLAW_LAUNCH_ID: id.launchId, TANGLECLAW_PROJECT_ID: id.projectId, TANGLECLAW_WORKSPACE_ID: id.workspaceId };
}

/**
 * What the write floor makes of a request's launch headers, as the server does
 * (`lib/launch-binding-guard.js`): none is REQUIRED; an unknown launch id, or
 * one paired with another project's id (`project-mismatch`), is INVALID. Like
 * the server, it does not compare a valid binding with the route's project.
 * @param {object} headers - Request headers
 * @returns {{status: number, body: object}|null} The refusal, or null when admitted
 */
function bindingFloor(headers) {
  const launchId = headers['x-tangleclaw-launch-id'];
  const projectId = headers['x-tangleclaw-project-id'];
  if (!launchId && !projectId) return { status: 403, body: { code: 'LAUNCH_BINDING_REQUIRED' } };
  const owner = Object.values(FLEET).find((f) => f.launchId === launchId);
  if (!owner) return { status: 403, body: { code: 'LAUNCH_BINDING_INVALID', reason: 'unknown-launch' } };
  if (owner.projectId !== projectId) return { status: 403, body: { code: 'LAUNCH_BINDING_INVALID', reason: 'project-mismatch' } };
  return null;
}

/**
 * A fake TangleClaw with two stub-engine panes. A `/soak-medusa` line typed
 * into a pane runs the real stub engine's client (`handleMedusa`) with that
 * pane's env, against this same fake, and its result line lands in the pane
 * for `peek` to read, as on a real server. Each route can be overridden.
 * @param {object} [over] - `{status(p), launch(p), medusaStatus(p, n), command(p, req), whoami(req), send(req), messages(n, req), read(req), kill(p), env(p), clock}`
 * @returns {{fetch: Function, calls: object[], panes: Object<string, string[]>, inbox: object[]}} Fake
 */
function fakeFleet(over = {}) {
  const polls = {};
  const panes = { 'soak-a': ['soak-stub ready'], 'soak-b': ['soak-stub ready'] };
  const inbox = [];
  let inboxReads = 0;
  let sent = 0;
  const projectOf = (headers) => Object.keys(FLEET).find((p) => FLEET[p].launchId === headers['x-tangleclaw-launch-id']);
  const o = {
    status: () => ({ status: 200, body: { active: false } }),
    launch: () => ({ status: 200, body: {} }),
    medusaStatus: (p) => ({ status: 200, body: { state: 'listening', workspaceId: FLEET[p].workspaceId } }),
    command: () => null,
    whoami: (req) => {
      const p = projectOf(req.headers);
      const claimed = Object.keys(FLEET).find((k) => FLEET[k].projectId === req.query.get('projectId'));
      return { status: 200, body: { project: claimed ? { id: Number(FLEET[claimed].projectId), name: claimed } : null, binding: p ? { state: 'verified', projectId: Number(FLEET[p].projectId) } : { state: 'unbound', projectId: null }, workspaceId: req.query.get('workspaceId') } };
    },
    send: (req) => {
      const id = `msg-${++sent}`;
      inbox.push({ id, message: req.body.message });
      return { status: 200, body: { id } };
    },
    messages: () => ({ status: 200, body: { messages: [{ id: 'msg-0', message: 'unrelated' }, ...inbox] } }),
    read: () => ({ status: 200, body: {} }),
    kill: () => ({ status: 200, body: {} }),
    env: paneEnv,
    clock: null,
    ...over
  };
  const fake = fakeFetch((req) => {
    if (req.path === '/api/tc/whoami') return o.whoami(req);
    const m = req.path.match(/^\/api\/sessions\/([^/]+)(\/.*)?$/);
    const project = decodeURIComponent(m[1]);
    const rest = m[2] || '';
    if (req.method === 'GET' && rest === '/status') return o.status(project);
    if (req.method === 'POST' && rest === '') return o.launch(project);
    if (req.method === 'DELETE' && rest === '') return o.kill(project);
    if (rest === '/medusa/status') { polls[project] = (polls[project] || 0) + 1; return o.medusaStatus(project, polls[project]); }
    if (rest === '/peek') return { status: 200, body: { lines: panes[project].slice(-ex.PEEK_LINES) } };
    if (rest === '/command') {
      const answered = o.command(project, req);
      if (answered) return answered;
      const line = req.body.command;
      panes[project].push(`stub> ${line}`);
      const cmd = stubEngine.parseMedusaLine(line);
      if (cmd) {
        const clock = o.clock || {};
        stubEngine.handleMedusa(cmd, o.env(project), { fetch: fake.fetch, now: clock.now, sleep: clock.sleep }).then((result) => panes[project].push(result));
      } else panes[project].push('ack');
      return { status: 200, body: { ok: true } };
    }
    if (['/medusa/send', '/medusa/messages', '/medusa/read'].includes(rest)) {
      const refused = bindingFloor(req.headers || {});
      if (refused) return refused;
      if (rest === '/medusa/send') return o.send(req);
      if (rest === '/medusa/messages') return o.messages(++inboxReads, req);
      return o.read(req);
    }
    throw new Error(`unexpected ${req.method} ${req.path}`);
  });
  return { ...fake, panes, inbox };
}

/**
 * Whether a recorded call was made from inside a pane (it carries a launch binding).
 * @param {object} c - Recorded call
 * @returns {boolean} From a pane
 */
const fromPane = (c) => Boolean(c.headers && c.headers['x-tangleclaw-launch-id']);

describe('soak executors — switchboard cycle', () => {
  const PAIR = { from: 'soak-a', to: 'soak-b' };
  const route = (c) => `${c.method} ${c.path}`;
  /**
   * Run one cycle against a fake fleet, sharing one fake clock between the
   * driver and the panes.
   * @param {object} [over] - fakeFleet overrides
   * @param {object} [extra] - Extra context
   * @returns {Promise<{r: object, f: object, clock: object}>} Outcome, fake and clock
   */
  async function cycle(over = {}, extra = {}) {
    const clock = fakeClock();
    const f = fakeFleet({ clock, ...over });
    const r = await ex.EXECUTORS['engine.session.medusa-cycle'](ctx(f.fetch, { ...clock, ...extra }), PAIR);
    return { r, f, clock };
  }

  it('guards both, launches both, waits for listeners, and has each session make its own switchboard calls, then kills both', async () => {
    let n = 0;
    const runKey = `${'c'.repeat(16)}-1790000000000`;
    const { r, f, clock } = await cycle({ medusaStatus: (p) => ({ status: 200, body: { state: ++n <= 3 ? 'connecting' : 'listening', workspaceId: FLEET[p].workspaceId } }) }, { eventIndex: 41, runKey, nonce: () => '0a1b2c3d' });
    assert.deepEqual(r, { ok: true, code: 'OK', status: null, step: null, steps: 7, messageId: 'msg-1' });
    const driver = f.calls.filter((c) => !fromPane(c)).map(route);
    assert.deepEqual(driver.slice(0, 4), ['GET /api/sessions/soak-a/status', 'GET /api/sessions/soak-b/status', 'POST /api/sessions/soak-a', 'POST /api/sessions/soak-b']);
    assert.deepEqual(driver.filter((c) => !c.includes('/medusa/status') && !c.includes('/peek')).slice(4), ['POST /api/sessions/soak-a/command', 'POST /api/sessions/soak-b/command', 'DELETE /api/sessions/soak-a', 'DELETE /api/sessions/soak-b']);
    for (const launch of f.calls.filter((c) => c.method === 'POST' && /^\/api\/sessions\/[^/]+$/.test(c.path))) {
      assert.deepEqual(launch.body, { engineOverride: ex.STUB_ENGINE_ID, primePrompt: false });
    }
    const typed = f.calls.filter((c) => c.path.endsWith('/command')).map((c) => c.body.command);
    assert.deepEqual(typed, [
      `/soak-medusa send 0a1b2c3d soak-a ws-b e41-0a1b2c3d soak-medusa-${runKey}-41`,
      '/soak-medusa read 0a1b2c3d soak-b e41-0a1b2c3d'
    ], 'the recipient\'s workspace from its own status, and a request id scoped to the run, since the server keeps request ids unique across all sends');

    const pane = f.calls.filter(fromPane);
    const as = (p) => pane.filter((c) => c.headers['x-tangleclaw-launch-id'] === FLEET[p].launchId).map(route);
    assert.deepEqual(as('soak-a'), ['GET /api/tc/whoami', 'POST /api/sessions/soak-a/medusa/send'], 'the sender\'s own pane sends');
    assert.deepEqual(as('soak-b'), ['GET /api/tc/whoami', 'GET /api/sessions/soak-b/medusa/messages', 'POST /api/sessions/soak-b/medusa/read'], 'the recipient\'s own pane reads its inbox and marks the message handled');
    assert.deepEqual(f.calls.find((c) => c.path.endsWith('/medusa/read')).body, { ids: ['msg-1'] });
    assert.ok(clock.slept.length > 0, 'the waits used the injected sleep');
  });

  it('makes no switchboard write and no inbox read of its own: every such call comes from a pane, under that pane\'s binding only', async () => {
    const { f } = await cycle();
    const switchboard = f.calls.filter((c) => /\/medusa\/(send|read|messages)$/.test(c.path));
    assert.equal(switchboard.length, 3);
    for (const c of switchboard) {
      assert.ok(fromPane(c), `${route(c)} came from the driver`);
      assert.equal(c.headers.cookie, undefined);
      assert.equal(c.headers['x-csrf-token'], undefined);
      assert.equal(c.headers.authorization, undefined);
      const project = decodeURIComponent(c.path.split('/')[3]);
      assert.equal(c.headers['x-tangleclaw-launch-id'], FLEET[project].launchId, `${route(c)} carried another session's binding`);
      assert.equal(c.headers['x-tangleclaw-project-id'], FLEET[project].projectId);
    }
  });

  it('never puts a launch id in an outcome, whatever happens', async () => {
    const outcomes = [];
    for (const over of [{}, { send: () => ({ status: 403, body: { code: 'LAUNCH_BINDING_INVALID', error: FLEET['soak-a'].launchId } }) }, { messages: () => ({ status: 200, body: { messages: [] } }) }, { env: () => ({}) }]) {
      outcomes.push((await cycle(over)).r);
    }
    const text = JSON.stringify(outcomes);
    for (const id of Object.values(FLEET)) assert.equal(text.includes(id.launchId), false);
  });

  it('types the same request id on a rerun of the same event in the same run, and none without an event index and run key', async () => {
    const sends = [];
    const runKey = `${'d'.repeat(16)}-1790000000001`;
    for (const extra of [{ eventIndex: 3, runKey }, { eventIndex: 3, runKey }, {}, { eventIndex: 3 }]) {
      const { f } = await cycle({}, extra);
      sends.push(f.calls.find((c) => c.path.endsWith('/medusa/send')).body);
    }
    assert.equal(sends[0].requestId, `soak-medusa-${runKey}-3`);
    assert.equal(sends[1].requestId, sends[0].requestId);
    assert.equal(sends[2].requestId, undefined);
    assert.equal(sends[3].requestId, undefined, 'an unscoped id could collide with another run\'s');
    assert.notEqual(sends[0].message, sends[1].message, 'each event\'s tag carries a fresh nonce');
  });

  for (const which of ['soak-a', 'soak-b']) {
    it(`never touches a foreign session on ${which}, and launches nothing`, async () => {
      const { r, f } = await cycle({ status: (p) => ({ status: 200, body: p === which ? { active: true, engine: 'claude' } : { active: false } }) });
      assert.deepEqual([r.ok, r.code, r.step, r.project, r.foreignEngine], [false, 'FOREIGN_SESSION', 'status', which, 'claude']);
      assert.ok(f.calls.every((c) => c.method === 'GET'), JSON.stringify(f.calls.map(route)));
    });

    it(`kills nothing when ${which}'s status cannot be read`, async () => {
      const { r, f } = await cycle({ status: (p) => (p === which ? { status: 503, body: {} } : { status: 200, body: { active: false } }) });
      assert.deepEqual([r.ok, r.code, r.status, r.step, r.project], [false, 'HTTP_STATUS', 503, 'status', which]);
      assert.ok(f.calls.every((c) => c.method === 'GET'));
    });
  }

  it('clears leftover soak-stub sessions on both projects and reports them', async () => {
    const { r, f } = await cycle({ status: () => ({ status: 200, body: { active: true, engine: 'soak-stub' } }) });
    assert.equal(r.ok, true);
    assert.deepEqual(r.preKilled, ['soak-a', 'soak-b']);
    assert.deepEqual(f.calls.slice(0, 4).map(route), ['GET /api/sessions/soak-a/status', 'DELETE /api/sessions/soak-a', 'GET /api/sessions/soak-b/status', 'DELETE /api/sessions/soak-b']);
  });

  it('kills nothing when the first launch fails', async () => {
    const { r, f } = await cycle({ launch: () => ({ status: 500, body: {} }) });
    assert.deepEqual([r.ok, r.code, r.step, r.project], [false, 'HTTP_STATUS', 'launch', 'soak-a']);
    assert.equal(f.calls.some((c) => c.method === 'DELETE'), false);
  });

  it('kills both when the second launch fails, treating a 404 for the unlaunched one as clean', async () => {
    const { r, f } = await cycle({ launch: (p) => (p === 'soak-b' ? { status: 500, body: {} } : { status: 200, body: {} }), kill: (p) => (p === 'soak-b' ? { status: 404, body: {} } : { status: 200, body: {} }) });
    assert.deepEqual([r.ok, r.code, r.step, r.project, r.cleanupFailed], [false, 'HTTP_STATUS', 'launch', 'soak-b', false]);
    assert.deepEqual(f.calls.filter((c) => c.method === 'DELETE').map(route), ['DELETE /api/sessions/soak-a', 'DELETE /api/sessions/soak-b']);
    assert.equal(f.calls.some((c) => c.path.includes('/medusa/') || c.path.endsWith('/command')), false, 'no switchboard step after a failed launch');
  });

  it('reports NOT_LISTENING, naming the laggard, when the budget runs out, and still kills both', async () => {
    const { r, f, clock } = await cycle({ medusaStatus: (p) => ({ status: 200, body: { state: p === 'soak-b' ? 'reconnecting' : 'listening', workspaceId: FLEET[p].workspaceId } }) });
    assert.deepEqual([r.ok, r.code, r.step, r.notListening, r.cleanupFailed], [false, 'NOT_LISTENING', 'listen', ['soak-b'], false]);
    assert.ok(clock.slept.reduce((a, b) => a + b, 0) >= ex.POLL.listenMs, 'the whole budget was spent');
    assert.ok(clock.slept.reduce((a, b) => a + b, 0) <= ex.POLL.listenMs, 'and not more');
    assert.equal(f.calls.filter((c) => c.path === '/api/sessions/soak-a/medusa/status').length, 1, 'a listening project is not read again');
    assert.deepEqual(f.calls.filter((c) => c.method === 'DELETE').length, 2);
    assert.equal(f.calls.some((c) => c.path.endsWith('/command')), false);
  });

  it('fails at the listen step when a switchboard status read fails, and still kills both', async () => {
    const { r, f } = await cycle({ medusaStatus: (p) => (p === 'soak-b' ? { status: 500, body: {} } : { status: 200, body: { state: 'listening', workspaceId: FLEET[p].workspaceId } }) });
    assert.deepEqual([r.ok, r.code, r.status, r.step, r.project, r.cleanupFailed], [false, 'HTTP_STATUS', 500, 'listen', 'soak-b', false]);
    assert.equal(f.calls.filter((c) => c.method === 'DELETE').length, 2);
  });

  it('reports BAD_BODY when the recipient listens without a workspace id it can type, and types nothing', async () => {
    for (const workspaceId of [undefined, 'ws b; rm', '']) {
      const { r, f } = await cycle({ medusaStatus: () => ({ status: 200, body: { state: 'listening', workspaceId } }) });
      assert.deepEqual([r.ok, r.code, r.step, r.project], [false, 'BAD_BODY', 'listen', 'soak-b'], String(workspaceId));
      assert.equal(f.calls.some((c) => c.path.endsWith('/command')), false);
      assert.equal(f.calls.filter((c) => c.method === 'DELETE').length, 2);
    }
  });

  it('carries the server\'s binding refusal of the send unchanged: a launch id paired with another project\'s id, and no binding', async () => {
    // Session A's launch id with project B's id: the floor's project-mismatch.
    const mismatch = await cycle({
      env: (p) => ({ ...paneEnv(p), TANGLECLAW_PROJECT_ID: FLEET['soak-b'].projectId }),
      whoami: (req) => ({ status: 200, body: { project: { id: Number(req.query.get('projectId')), name: 'soak-a' }, binding: { state: 'verified', projectId: Number(req.query.get('projectId')) }, workspaceId: req.query.get('workspaceId') } })
    });
    assert.deepEqual([mismatch.r.ok, mismatch.r.code, mismatch.r.status, mismatch.r.step, mismatch.r.project, mismatch.r.cleanupFailed], [false, 'LAUNCH_BINDING_INVALID', 403, 'send', 'soak-a', false]);
    assert.equal(mismatch.f.inbox.length, 0, 'nothing was sent');

    const required = await cycle({ send: () => ({ status: 403, body: { code: 'LAUNCH_BINDING_REQUIRED' } }) });
    assert.deepEqual([required.r.code, required.r.status, required.r.step], ['LAUNCH_BINDING_REQUIRED', 403, 'send']);
  });

  it('records a resent request id the server refuses as SEND_ALREADY_ATTEMPTED, never as a failed send', async () => {
    const { r } = await cycle({ send: () => ({ status: 409, body: { code: 'SEND_ALREADY_ATTEMPTED' } }) }, { eventIndex: 7, runKey: `${'a'.repeat(16)}-1790000000000` });
    assert.deepEqual([r.ok, r.code, r.status, r.step, r.project], [false, ex.OUTCOME.SEND_ALREADY_ATTEMPTED, 409, 'send', 'soak-a']);
  });

  it('reports a send refused without a code, or answered with no message id', async () => {
    for (const [send, code, status] of [[{ status: 500, body: {} }, 'HTTP_STATUS', 500], [{ status: 200, body: {} }, 'BAD_BODY', null]]) {
      const { r, f } = await cycle({ send: () => send });
      assert.deepEqual([r.ok, r.code, r.status, r.step, r.project, r.cleanupFailed], [false, code, status, 'send', 'soak-a', false]);
      assert.equal(f.calls.filter((c) => c.method === 'DELETE').length, 2);
      assert.equal(f.calls.filter((c) => c.path.endsWith('/command')).length, 1, 'the recipient is never asked to read');
    }
  });

  for (const [what, over, code, project] of [
    ['the sender\'s pane has no API origin', { env: (p) => (p === 'soak-a' ? { ...paneEnv(p), TANGLECLAW_API: '' } : paneEnv(p)) }, 'IN_PANE_NO_API', 'soak-a'],
    ['the sender\'s pane has no launch binding', { env: (p) => (p === 'soak-a' ? { ...paneEnv(p), TANGLECLAW_LAUNCH_ID: undefined } : paneEnv(p)) }, 'IN_PANE_NO_BINDING', 'soak-a'],
    ['whoami calls the sender\'s binding stale', { whoami: () => ({ status: 200, body: { project: { id: 11, name: 'soak-a' }, binding: { state: 'stale', projectId: 11 }, workspaceId: 'ws-a' } }) }, 'IN_PANE_BINDING_UNVERIFIED', 'soak-a'],
    ['whoami resolves another project than the route\'s', { whoami: () => ({ status: 200, body: { project: { id: 11, name: 'soak-z' }, binding: { state: 'verified', projectId: 11 }, workspaceId: 'ws-a' } }) }, 'IN_PANE_WRONG_PROJECT', 'soak-a'],
    ['whoami fails', { whoami: () => ({ status: 500, body: {} }) }, 'IN_PANE_WHOAMI_FAILED', 'soak-a']
  ]) {
    it(`reports ${code}, with no switchboard call and nothing sent, when ${what}`, async () => {
      const { r, f } = await cycle(over);
      assert.deepEqual([r.ok, r.code, r.status, r.step, r.project, r.cleanupFailed], [false, code, null, 'send', project, false]);
      assert.equal(f.calls.some((c) => /\/medusa\/(send|read|messages)$/.test(c.path)), false);
      assert.equal(f.calls.filter((c) => c.method === 'DELETE').length, 2);
    });
  }

  it('reports IN_PANE_WRONG_PROJECT when the recipient\'s pane is asked to read a route that is not its own', async () => {
    const { r, f } = await cycle({ env: (p) => (p === 'soak-b' ? paneEnv('soak-a') : paneEnv(p)) });
    assert.deepEqual([r.ok, r.code, r.step, r.project], [false, 'IN_PANE_WRONG_PROJECT', 'read', 'soak-b']);
    assert.equal(f.calls.some((c) => /\/medusa\/(read|messages)$/.test(c.path)), false);
  });

  it('reports IN_PANE_SILENT when a pane prints no result line within the budget, and still kills both', async () => {
    const { r, f, clock } = await cycle({ command: () => ({ status: 200, body: { ok: true } }) });
    assert.deepEqual([r.ok, r.code, r.status, r.step, r.project, r.cleanupFailed], [false, 'IN_PANE_SILENT', null, 'send', 'soak-a', false]);
    assert.ok(clock.slept.reduce((a, b) => a + b, 0) >= ex.POLL.deliveryMs);
    assert.equal(f.calls.filter((c) => c.method === 'DELETE').length, 2);
  });

  it('never reads the echoed command, or another event\'s result line, as this event\'s answer', async () => {
    const f0 = fakeFleet();
    f0.panes['soak-a'].push('stub> /soak-medusa send 0a1b2c3d soak-a ws-b e1-0a1b2c3d', 'soak-medusa ffffffff send ok id=msg-9');
    const clock = fakeClock();
    const typedOnly = fakeFleet({ clock, command: (p, req) => { f0.panes[p].push(`stub> ${req.body.command}`); return { status: 200, body: { ok: true } }; } });
    typedOnly.panes['soak-a'] = f0.panes['soak-a'];
    const r = await ex.EXECUTORS['engine.session.medusa-cycle'](ctx(typedOnly.fetch, { ...clock, nonce: () => '0a1b2c3d' }), PAIR);
    assert.deepEqual([r.code, r.step], ['IN_PANE_SILENT', 'send']);
  });

  it('fails at the send step when typing into the pane is refused, and at its step when the pane cannot be read', async () => {
    const typed = await cycle({ command: () => ({ status: 409, body: { code: 'STARTUP_DIALOG' } }) });
    assert.deepEqual([typed.r.code, typed.r.status, typed.r.step, typed.r.project], ['HTTP_STATUS', 409, 'send', 'soak-a']);
    const unread = await cycle({ command: (p, req) => (p === 'soak-b' ? { status: 404, body: {} } : null) });
    assert.deepEqual([unread.r.code, unread.r.status, unread.r.step, unread.r.project], ['HTTP_STATUS', 404, 'read', 'soak-b']);
  });

  it('waits for delivery in the recipient\'s own inbox, and reports NOT_DELIVERED at the deliver step when its wait runs out', async () => {
    const untagged = await cycle({ messages: () => ({ status: 200, body: { messages: [{ id: 'msg-1', message: 'soak medusa-cycle e-other' }] } }) });
    assert.equal(untagged.r.code, 'NOT_DELIVERED', 'a message without this event\'s tag is not this event\'s message');

    const clock = fakeClock();
    const f = fakeFleet({ clock, messages: (n) => ({ status: 200, body: { messages: n < 4 ? [] : f.inbox } }) });
    const r = await ex.EXECUTORS['engine.session.medusa-cycle'](ctx(f.fetch, clock), PAIR);
    assert.equal(r.ok, true);
    assert.equal(f.calls.filter((c) => c.path.endsWith('/medusa/messages')).length, 4);

    const never = await cycle({ messages: () => ({ status: 200, body: { messages: [] } }) });
    assert.deepEqual([never.r.ok, never.r.code, never.r.step, never.r.project, never.r.cleanupFailed], [false, 'NOT_DELIVERED', 'deliver', 'soak-b', false]);
    assert.equal(never.f.calls.some((c) => c.path.endsWith('/medusa/read')), false, 'nothing is marked read that never arrived');
    assert.equal(never.f.calls.filter((c) => c.method === 'DELETE').length, 2);
  });

  it('fails at the read step when the recipient\'s inbox read or mark-handled is refused, with the server\'s code', async () => {
    const inbox = await cycle({ messages: () => ({ status: 502, body: {} }) });
    assert.deepEqual([inbox.r.code, inbox.r.status, inbox.r.step], ['HTTP_STATUS', 502, 'read']);
    const marked = await cycle({ read: () => ({ status: 403, body: { code: 'LAUNCH_BINDING_INVALID' } }) });
    assert.deepEqual([marked.r.ok, marked.r.code, marked.r.status, marked.r.step, marked.r.project, marked.r.cleanupFailed], [false, 'LAUNCH_BINDING_INVALID', 403, 'read', 'soak-b', false]);
    assert.equal(marked.f.calls.filter((c) => c.method === 'DELETE').length, 2);
  });

  it('reports BAD_BODY when the recipient marks a different message than the one sent', async () => {
    const inbox = [];
    const { r, f } = await cycle({ send: (req) => { inbox.push({ id: 'msg-other', message: req.body.message }); return { status: 200, body: { id: 'msg-sent' } }; }, messages: () => ({ status: 200, body: { messages: inbox } }) });
    assert.deepEqual([r.ok, r.code, r.step, r.project], [false, 'BAD_BODY', 'read', 'soak-b']);
    assert.equal(f.calls.filter((c) => c.method === 'DELETE').length, 2);
  });

  it('attempts both kills even when the first fails, and reports the failure', async () => {
    const { r, f } = await cycle({ kill: (p) => (p === 'soak-a' ? { status: 500, body: {} } : { status: 200, body: {} }) });
    assert.deepEqual([r.ok, r.code, r.status, r.step, r.project], [false, 'HTTP_STATUS', 500, 'kill', 'soak-a']);
    assert.equal(f.calls.filter((c) => c.method === 'DELETE').length, 2);

    const g = await cycle({ read: () => ({ status: 500, body: {} }), kill: (p) => (p === 'soak-b' ? { status: 500, body: {} } : { status: 200, body: {} }) });
    assert.deepEqual([g.r.step, g.r.cleanupFailed], ['read', true]);
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
    const clock = fakeClock();
    const f = fakeFleet({ clock, send: () => ({ status: 409, body: { error: 'already attempted', code: 'SEND_ALREADY_ATTEMPTED' } }) });
    const out = await ex.EXECUTORS['engine.session.medusa-cycle'](ctx(f.fetch, { ...clock, eventIndex: 7, runKey: `${'a'.repeat(16)}-1790000000000` }), { from: 'soak-a', to: 'soak-b' });
    assert.equal(f.calls.find((c) => c.path.endsWith('/medusa/send')).body.requestId, `soak-medusa-${'a'.repeat(16)}-1790000000000-7`);
    assert.equal(out.code, ex.OUTCOME.SEND_ALREADY_ATTEMPTED);
    assert.equal(out.step, 'send');
    assert.notEqual(out.code, ex.OUTCOME.HTTP_STATUS, 'never recorded as a failed send');
  });
});

describe('soak executors — who each call speaks for', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { DatabaseSync } = require('node:sqlite');
  const faults = require('../lib/soak/faults');
  const browser = require('../lib/soak/browser');
  const wd = require('../lib/soak/webdriver');
  const { RUN_EXECUTORS, RUN_OPERATOR_KINDS } = require('../scripts/soak');

  const TOKEN = 'principal-test-session-token';
  const CSRF = 'principal-test-csrf-token';
  const PASSWORD = 'principal-test-password-9876';
  const WEBDRIVER = 'http://127.0.0.1:4444';
  const SESSION = '/api/sessions/soak-[ab]';

  /**
   * Every mutating call each kind can make, with its principal. A kind or a
   * call missing here fails the test, so a new one cannot ship without its
   * principal being decided.
   */
  const PRINCIPALS = {
    'api.health': [],
    'api.server-info': [],
    'api.projects.list': [],
    'api.ports.list': [],
    'api.plans.read': [],
    'api.medusa.reads': [],
    'api.ports.lease-release': [['POST', '/api/ports/lease', 'operator'], ['POST', '/api/ports/release', 'operator']],
    'engine.session.cycle': [['DELETE', SESSION, 'operator'], ['POST', SESSION, 'operator'], ['POST', `${SESSION}/command`, 'operator']],
    // The two switchboard writes are made by the sessions themselves, in their
    // own panes; the driver only types the instruction (`/command`).
    'engine.session.medusa-cycle': [['DELETE', SESSION, 'operator'], ['POST', SESSION, 'operator'], ['POST', `${SESSION}/command`, 'operator'], ['POST', `${SESSION}/medusa/send`, 'session'], ['POST', `${SESSION}/medusa/read`, 'session']],
    'engine.session.wrap-cycle': [['DELETE', SESSION, 'operator'], ['POST', SESSION, 'operator'], ['POST', `${SESSION}/wrap`, 'operator']],
    'fault.server.restart': [['POST', '/api/server/restart', 'operator']],
    'fault.tmux.session-kill': [['DELETE', SESSION, 'operator'], ['POST', SESSION, 'operator']],
    'fault.client.abort': [],
    'fault.db.lock-contention': [['POST', '/api/ports/lease', 'operator'], ['POST', '/api/ports/release', 'operator']],
    'fault.disk.pressure': [['POST', '/api/ports/lease', 'operator'], ['POST', '/api/ports/release', 'operator']],
    'fault.ttyd.restart': [],
    'browser.dashboard.load': [],
    'browser.terminal.attach': [['DELETE', SESSION, 'operator'], ['POST', SESSION, 'operator']]
  };

  const PARAMS = { project: 'soak-a', from: 'soak-a', to: 'soak-b', commands: 2, port: 5601 };

  /**
   * One fake target and WebDriver that walk every executor's whole path.
   * `leftover` makes the first status read of each project report a soak-stub
   * session, so the leftover kill is exercised too.
   * @param {{leftover: boolean}} opt - Scenario
   * @returns {{fetch: Function, calls: object[]}} Fake and its log
   */
  function fakeTarget(opt, clock) {
    const calls = [];
    const seenStatus = new Set();
    const panes = {};
    const inbox = [];
    let restarted = false;
    let attaches = 0;
    const json = (status, body, headers) => ({ status, headers, text: async () => JSON.stringify(body) });
    const fetch = async (url, init) => {
      const h = init.headers || {};
      const req = { origin: url.origin, method: init.method, path: url.pathname, cookie: h.cookie, csrf: h['x-csrf-token'], launch: h['x-tangleclaw-launch-id'], launchProject: h['x-tangleclaw-project-id'], body: init.body };
      calls.push(req);
      if (url.origin === WEBDRIVER) {
        const body = init.body ? JSON.parse(init.body) : {};
        if (req.path === '/session' && req.method === 'POST') return json(200, { value: { sessionId: 'wd1' } });
        if (req.path.endsWith('/element')) return json(200, { value: { [wd.ELEMENT_KEY]: 'el1' } });
        if (req.path.endsWith('/execute/sync')) {
          if (body.script === browser.DASHBOARD_PROBE) return json(200, { value: '3m' });
          if (body.script.includes(browser.TERMINAL_FRAME)) return json(200, { value: '/terminal/soak-a' });
          return json(200, { value: true });
        }
        return json(200, { value: null });
      }
      const m = req.path.match(/^\/api\/sessions\/([^/]+)(\/.*)?$/);
      if (req.path === '/api/auth/login') {
        return json(200, { username: 'soak-operator', csrfToken: CSRF }, { getSetCookie: () => [`tc_session=${TOKEN}; Path=/; HttpOnly`, `tc_csrf=${CSRF}; Path=/`] });
      }
      if (req.path === '/api/server-info') return json(200, { startedAt: restarted ? 'B' : 'A' });
      if (req.path === '/api/server/restart') { restarted = true; return json(202, {}); }
      if (req.path === '/api/system/pty-activity') return json(200, { instance: 'i1', attaches: attaches++ });
      if (req.path.endsWith('/plans')) return json(200, { plans: [{ file: ex.PLAN_FILE, urlPath: '/plans/1/soak-plan.md' }] });
      if (req.path === '/api/ports/lease') return json(201, {});
      if (req.path === '/api/tc/whoami') {
        const p = Object.keys(FLEET).find((k) => FLEET[k].launchId === req.launch);
        return json(200, { project: p ? { id: Number(FLEET[p].projectId), name: p } : null, binding: p ? { state: 'verified', projectId: Number(FLEET[p].projectId) } : { state: 'unbound' }, workspaceId: url.searchParams.get('workspaceId') });
      }
      if (m) {
        const [, project, rest = ''] = m;
        if (rest === '/status') {
          const first = !seenStatus.has(project);
          seenStatus.add(project);
          return json(200, opt.leftover && first ? { active: true, engine: ex.STUB_ENGINE_ID } : { active: false });
        }
        if (rest === '' && req.method === 'POST') return json(200, { engine: ex.STUB_ENGINE_ID, tmuxSession: faults.tmuxName(project) });
        if (rest === '/medusa/status') return json(200, { state: 'listening', workspaceId: `ws-${project}` });
        if (rest === '/command') {
          const cmd = stubEngine.parseMedusaLine(JSON.parse(init.body).command);
          if (cmd) {
            panes[project] = panes[project] || [];
            const env = { ...paneEnv(project), TANGLECLAW_API: url.origin };
            stubEngine.handleMedusa(cmd, env, { fetch, now: clock.now, sleep: clock.sleep }).then((line) => panes[project].push(line));
          }
          return json(200, {});
        }
        if (rest === '/peek') return json(200, { lines: panes[project] || [] });
        if (rest === '/medusa/send') {
          inbox.push({ id: 'msg1', message: JSON.parse(init.body).message });
          return json(200, { id: 'msg1' });
        }
        if (rest === '/medusa/messages') return json(200, { messages: inbox });
        if (rest === '/wrap') return json(202, { runId: 'run1' });
        if (rest === '/wrap/status') return json(200, { runId: 'run1', finishedAt: 1, result: { ok: true, sessionOutcome: 'ended', pipelineResult: { ok: true } } });
      }
      return json(200, {});
    };
    return { fetch, calls };
  }

  /**
   * Run one kind, signed in, against a fresh fake target.
   * @param {string} kind - Event kind
   * @param {{leftover: boolean}} opt - Scenario
   * @param {string} home - A guest-like home holding a real database
   * @returns {Promise<{outcome: object, calls: object[]}>} What it did
   */
  async function runKind(kind, opt, home) {
    let clock = 1_000_000;
    const now = () => clock;
    const sleep = async (ms) => { clock += ms; };
    const t = fakeTarget(opt, { now, sleep });
    const c = {
      apiBase: 'http://127.0.0.1:3102/',
      token: null,
      fetch: t.fetch,
      now,
      sleep,
      eventIndex: 3,
      runKey: 'abcdef0123456789-1700000000000',
      local: {
        home,
        dbPath: path.join(home, 'tangleclaw.db'),
        uid: process.getuid(),
        phase: 'certifying',
        webdriver: WEBDRIVER,
        run: async () => ({ code: 0, stdout: '', stderr: '', error: null }),
        fs: { ...fs, statfsSync: () => ({ bavail: (5 * 1024 * 1024) / 4096, bsize: 4096 }) },
        limits: { ballastFloorBytes: 2 * 1024 * 1024, ballastMaxBytes: 4 * 1024 * 1024, ballastMinBytes: 1024 * 1024, ballastChunkBytes: 1024 * 1024, aborts: 2, abortAfterMs: 1000 }
      }
    };
    c.operator = ex.createOperator({ username: 'soak-operator', password: PASSWORD });
    assert.equal((await c.operator.signIn(c)).ok, true);
    const outcome = await RUN_EXECUTORS[kind](c, PARAMS);
    return { outcome, calls: t.calls.filter((x) => x.path !== '/api/auth/login') };
  }

  let home;
  const setUp = () => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'soak-principals-')));
    const db = new DatabaseSync(path.join(home, 'tangleclaw.db'));
    db.exec('CREATE TABLE t (v INTEGER)');
    db.close();
  };

  it('has a principal entry for every kind the CLI can run, and no other', () => {
    assert.deepEqual(Object.keys(PRINCIPALS).sort(), Object.keys(RUN_EXECUTORS).sort());
  });

  it('sends every mutating call as the table says, carries no session on any read, and makes every listed call', async () => {
    setUp();
    try {
      const observed = new Set();
      for (const kind of Object.keys(RUN_EXECUTORS)) {
        for (const leftover of [false, true]) {
          const { outcome, calls } = await runKind(kind, { leftover }, home);
          assert.notEqual(outcome.code, 'EXECUTOR_THREW', `${kind}: ${JSON.stringify(outcome)}`);
          for (const c of calls.filter((x) => x.origin !== WEBDRIVER)) {
            if (/\/medusa\/(send|read|messages)$/.test(c.path)) {
              assert.ok(c.launch, `${kind}: ${c.method} ${c.path} was made by the driver, not from a session's pane`);
            }
            if (c.method === 'GET') {
              assert.deepEqual([c.cookie, c.csrf], [undefined, undefined], `${kind}: GET ${c.path} carried the session`);
              continue;
            }
            const entry = PRINCIPALS[kind].find(([method, re]) => method === c.method && new RegExp(`^${re}$`).test(c.path));
            assert.ok(entry, `${kind}: ${c.method} ${c.path} has no principal entry`);
            observed.add(`${kind} ${entry[0]} ${entry[1]}`);
            if (entry[2] === 'operator') {
              assert.equal(c.cookie, `tc_session=${TOKEN}`, `${kind}: ${c.method} ${c.path} without the session`);
              assert.equal(c.csrf, CSRF, `${kind}: ${c.method} ${c.path} without the CSRF token`);
              assert.equal(c.launch, undefined, `${kind}: ${c.method} ${c.path} carried a launch id`);
            } else if (entry[2] === 'session') {
              const project = decodeURIComponent(c.path.split('/')[3]);
              assert.deepEqual([c.launch, c.launchProject], [FLEET[project].launchId, FLEET[project].projectId], `${kind}: ${c.method} ${c.path} not under its own session's binding`);
              assert.deepEqual([c.cookie, c.csrf], [undefined, undefined], `${kind}: ${c.method} ${c.path} carried the Operator's session`);
            } else {
              assert.deepEqual([c.cookie, c.csrf], [undefined, undefined], `${kind}: ${c.method} ${c.path} carried the session`);
            }
          }
          assert.ok(!calls.some((c) => (c.body || '').includes(PASSWORD)), `${kind}: the password left the sign-in`);
        }
      }
      const listed = Object.entries(PRINCIPALS).flatMap(([kind, calls]) => calls.map(([m, re]) => `${kind} ${m} ${re}`));
      assert.deepEqual(listed.filter((e) => !observed.has(e)), [], 'every listed call was made by some run');
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('names as Operator kinds exactly the kinds that make an Operator call, and the browser events', () => {
    const writing = Object.entries(PRINCIPALS).filter(([, calls]) => calls.some((c) => c[2] === 'operator')).map(([k]) => k);
    assert.deepEqual([...RUN_OPERATOR_KINDS].sort(), [...new Set([...writing, ...browser.BROWSER_OPERATOR_KINDS])].sort());
  });
});

describe('soak executors — the Operator session', () => {
  const PASSWORD = 'session-test-password-4321';

  /**
   * A target whose login sets a session, and which answers each other
   * request from `answer`.
   * @param {Function} answer - `(req) => {status, body}`
   * @returns {{fetch: Function, calls: object[]}} Fake and its log
   */
  function signingIn(answer) {
    const calls = [];
    const fetch = async (url, init) => {
      const req = { href: url.href, method: init.method, path: url.pathname, headers: init.headers, body: init.body };
      calls.push(req);
      if (url.pathname === '/api/auth/login') {
        return { status: 200, headers: { getSetCookie: () => ['tc_session=tok-1; Path=/; HttpOnly', 'tc_csrf=csrf-1; Path=/'] }, text: async () => JSON.stringify({ username: 'soak-operator', csrfToken: 'csrf-1' }) };
      }
      const r = answer(req);
      return { status: r.status, text: async () => JSON.stringify(r.body || {}) };
    };
    return { fetch, calls };
  }

  const operator = () => ex.createOperator({ username: 'soak-operator', password: PASSWORD });

  it('signs in with the login, keeps the session out of every outcome, and never shows the secrets', async () => {
    const f = signingIn(() => ({ status: 200 }));
    const op = operator();
    const r = await op.signIn(ctx(f.fetch));
    assert.deepEqual(r, { ok: true, status: 200, code: 'OK' });
    assert.deepEqual(JSON.parse(f.calls[0].body), { username: 'soak-operator', password: PASSWORD });
    assert.equal(f.calls[0].redirect, undefined);
    assert.equal(op.signedIn, true);
    assert.deepEqual(op.headers(), { cookie: 'tc_session=tok-1', 'x-csrf-token': 'csrf-1' });
    const shown = [JSON.stringify(op), require('node:util').inspect(op), JSON.stringify({ ctx: { operator: op } }), String(require('node:util').format('%o', op))].join('\n');
    for (const secret of [PASSWORD, 'tok-1', 'csrf-1']) assert.ok(!shown.includes(secret), `${secret} shown`);
    assert.deepEqual(JSON.parse(JSON.stringify(op)), { username: 'soak-operator', signedIn: true });
  });

  it('records a refused sign-in by status and server code only', async () => {
    const fetch = async () => ({ status: 401, text: async () => JSON.stringify({ code: 'INVALID_CREDENTIALS', error: 'That username and password did not match.' }) });
    const op = operator();
    const r = await op.signIn(ctx(fetch));
    assert.deepEqual(r, { ok: false, status: 401, code: 'HTTP_STATUS', serverCode: 'INVALID_CREDENTIALS' });
    assert.equal(op.signedIn, false);
    assert.equal(op.headers(), null);
  });

  it('refuses a sign-in answer that sets no session', async () => {
    const fetch = async () => ({ status: 200, text: async () => JSON.stringify({ username: 'soak-operator', csrfToken: 'c' }) });
    const r = await operator().signIn(ctx(fetch));
    assert.deepEqual(r, { ok: false, status: 200, code: 'BAD_BODY' });
  });

  it('creates the first account with set-password, holding the session it signs in, and keeps none of its reply', async () => {
    const calls = [];
    const fetch = async (url, init) => {
      calls.push({ path: url.pathname, body: JSON.parse(init.body) });
      return { status: 200, headers: { getSetCookie: () => ['tc_session=tok-2; Path=/; HttpOnly', 'tc_csrf=c2; Path=/'] }, text: async () => JSON.stringify({ username: 'soak-operator', csrfToken: 'c2', recoveryCodes: ['AAAA-BBBB'] }) };
    };
    const op = operator();
    const r = await op.setPassword(ctx(fetch));
    assert.deepEqual(r, { ok: true, status: 200, code: 'OK', step: 'set-password' });
    assert.deepEqual(calls, [{ path: '/api/auth/set-password', body: { username: 'soak-operator', password: PASSWORD } }]);
    assert.deepEqual(op.headers(), { cookie: 'tc_session=tok-2', 'x-csrf-token': 'c2' });
    assert.ok(!JSON.stringify(r).includes('AAAA-BBBB'));
  });

  it('stops at a refused set-password, naming the step', async () => {
    const fetch = async () => ({ status: 409, text: async () => JSON.stringify({ code: 'ACCOUNT_EXISTS' }) });
    const r = await operator().setPassword(ctx(fetch));
    assert.deepEqual(r, { ok: false, status: 409, code: 'HTTP_STATUS', serverCode: 'ACCOUNT_EXISTS', step: 'set-password' });
  });

  it('never retries a 401: the session is dropped and the rest of the event sends no Operator call', async () => {
    let commands = 0;
    const f = signingIn((req) => {
      if (req.path.endsWith('/status')) return { status: 200, body: { active: false } };
      if (req.path.endsWith('/command')) { commands++; return { status: 401, body: { code: 'UNAUTHENTICATED' } }; }
      return { status: 200, body: {} };
    });
    const c = ctx(f.fetch, { operator: operator() });
    await c.operator.signIn(c);
    const r = await ex.EXECUTORS['engine.session.cycle'](c, { project: 'soak-a', commands: 3 });
    assert.equal(commands, 1, 'the refused command was not retried, and the next was never sent');
    assert.deepEqual([r.ok, r.code, r.status, r.step, r.cleanupFailed], [false, 'UNAUTHENTICATED', 401, 1, true]);
    assert.equal(c.operator.signedIn, false);
    const sentAfter = f.calls.slice(f.calls.findIndex((x) => x.path.endsWith('/command')) + 1);
    assert.deepEqual(sentAfter, [], 'the cleanup kill was not sent with no session');
    const kill = await ex.call(c, 'DELETE', '/api/sessions/soak-a', {}, ex.AS_OPERATOR);
    assert.deepEqual(kill, { ok: false, status: null, code: 'UNAUTHENTICATED', body: null });
  });

  it('treats a 401 on a call made for no one as any other status, and drops nothing', async () => {
    const f = signingIn(() => ({ status: 401, body: {} }));
    const c = ctx(f.fetch, { operator: operator() });
    await c.operator.signIn(c);
    const r = await ex.call(c, 'GET', '/api/projects');
    assert.equal(r.code, 'HTTP_STATUS');
    assert.equal(c.operator.signedIn, true);
  });

  it('sends the session only to the target\'s own origin', async () => {
    const f = signingIn(() => ({ status: 200, body: {} }));
    const c = ctx(f.fetch, { operator: operator() });
    await c.operator.signIn(c);
    await ex.call(c, 'POST', 'http://elsewhere.invalid:3102/api/ports/lease', {}, ex.AS_OPERATOR);
    await ex.call(c, 'POST', '/api/ports/lease', {}, ex.AS_OPERATOR);
    const [away, home] = f.calls.slice(1);
    assert.equal(away.href, 'http://elsewhere.invalid:3102/api/ports/lease');
    assert.deepEqual([away.headers.cookie, away.headers['x-csrf-token']], [undefined, undefined]);
    assert.deepEqual([home.headers.cookie, home.headers['x-csrf-token']], ['tc_session=tok-1', 'csrf-1']);
  });

  it('sends an Operator call as any other when no login is in the context', async () => {
    const f = fakeFetch(() => ({ status: 403, body: { code: 'LAUNCH_BINDING_REQUIRED' } }));
    const r = await ex.call(ctx(f.fetch), 'POST', '/api/ports/lease', {}, ex.AS_OPERATOR);
    assert.deepEqual([r.code, r.status, r.body.code], ['HTTP_STATUS', 403, 'LAUNCH_BINDING_REQUIRED']);
    assert.equal(f.calls[0].headers.cookie, undefined);
  });
});
