'use strict';

// v6.2.1 (#3038, Car V621-W1-A): Stage 2 browser-shell and conversation
// end-to-end qualification. Adapted from the Builders-A-D Stage 2 prototype
// (`v6-stage2-full-shell-and-conversation-e2e-suite.md`), which exercised an
// in-memory mock app; here every journey runs against the LIVE v6.0-v6.2
// code instead: the real request handler (server.js#handleRequest) over a
// real node:sqlite store, and the real public/v6-shell.js mounted on the
// repo's mini-DOM, with the shell's own `api`/`apiMutate` calls served by
// that same handler — so a shell render here is the data path a browser
// takes, minus the network socket.
//
// Not covered here, deliberately: the conversation route's session-status
// lookup needs a live tmux session (a subprocess this medium-tier file may
// not start), so the conversation journey drives the real event routes and
// renders their real output through the shell's own conversation markup.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const store = require('../lib/store');
const { handleRequest } = require('../server');
const { makeDocument, withIdParsingInnerHTML } = require('./_mini-dom');

/**
 * Load the real shipped public/v6-shell.js into a fresh sandbox.
 * @returns {object}
 */
function loadV6Shell() {
  const sandbox = { console };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'v6-shell.js'), 'utf8'), sandbox);
  return sandbox;
}

/**
 * A fake `window` with just the `location.hash`/`hashchange` plumbing the
 * shell drives itself with.
 * @param {string} [initialHash]
 * @returns {object}
 */
function makeFakeWindow(initialHash) {
  let hash = initialHash || '';
  const listeners = {};
  return {
    location: {
      get hash() { return hash; },
      set hash(v) { hash = v.startsWith('#') ? v : `#${v}`; (listeners.hashchange || []).slice().forEach((fn) => fn()); }
    },
    addEventListener(type, fn) { (listeners[type] || (listeners[type] = [])).push(fn); },
    removeEventListener(type, fn) { listeners[type] = (listeners[type] || []).filter((f) => f !== fn); }
  };
}

describe('v6 Stage 2 E2E: browser shell and conversation, against the live server (#3038)', () => {
  let tempDir;
  let prevBase;

  before(() => {
    prevBase = store._getBasePath();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-e2e-shell-'));
    store.close();
    store._setBasePath(tempDir);
    store.init();
  });

  after(() => {
    store.close();
    store._setBasePath(prevBase);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    const cfg = store.config.load();
    cfg.setupComplete = true;
    cfg.ingressMode = 'direct';
    cfg.authEnabled = false;
    store.config.save(cfg);
  });

  /**
   * One request through the real handler, as the dashboard operator unless
   * `operator: false`.
   * @param {string} method
   * @param {string} url
   * @param {{body?: object, operator?: boolean}} [opts]
   * @returns {Promise<{statusCode: number, body: string}>}
   */
  async function send(method, url, opts = {}) {
    const raw = opts.body === undefined ? null : JSON.stringify(opts.body);
    const headers = Object.assign({ host: 'localhost:3102' }, opts.operator === false ? {} : { 'x-tangleclaw-client': 'dashboard' });
    if (raw !== null) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(Buffer.byteLength(raw));
    }
    const req = {
      url, method, headers, socket: { remoteAddress: '127.0.0.1' },
      // A real IncomingMessage has resume(); the body parser drains an
      // over-limit request with it before answering 413.
      resume() {},
      on(event, cb) {
        if (event === 'data' && raw !== null) cb(Buffer.from(raw));
        if (event === 'end') cb();
      }
    };
    const res = {
      statusCode: 0, body: '', headers: {},
      setHeader(n, v) { this.headers[n.toLowerCase()] = v; },
      writeHead(status, h) { this.statusCode = status; for (const [k, v] of Object.entries(h || {})) this.headers[k.toLowerCase()] = v; },
      end(chunk) { if (chunk != null) this.body = String(chunk); }
    };
    await handleRequest(req, res);
    return res;
  }
  const json = (res) => JSON.parse(res.body);

  /**
   * The shell's `api`/`apiMutate`, served by the real handler: parsed JSON
   * on 2xx, null otherwise — the contract public/ui.js gives the shell.
   * @returns {{api: Function, apiMutate: Function, calls: string[]}}
   */
  function liveApi() {
    const calls = [];
    const api = async (url) => {
      calls.push(`GET ${url}`);
      const res = await send('GET', url);
      return res.statusCode >= 200 && res.statusCode < 300 ? json(res) : null;
    };
    const apiMutate = async (url, method, body) => {
      calls.push(`${method} ${url}`);
      const res = await send(method, url, { body: body || {} });
      return res.statusCode >= 200 && res.statusCode < 300 ? json(res) : null;
    };
    return { api, apiMutate, calls };
  }

  /**
   * Mount the real shell exactly as public/ui.js does, against the live API.
   * @param {string} initialHash
   * @returns {object}
   */
  function mountShell(initialHash) {
    const G = loadV6Shell();
    const { doc } = makeDocument([]);
    const root = doc.createElement('div');
    withIdParsingInnerHTML(root, doc);
    doc.body.appendChild(root);
    const win = makeFakeWindow(initialHash);
    const { api, apiMutate, calls } = liveApi();
    const pending = [];
    let shell = null;
    const live = G.tcV6CreateLiveController({ getShell: () => shell, api, apiMutate });
    shell = G.tcCreateV6Shell(doc, {
      root, window: win,
      onLaunchTemplate: (id) => pending.push(live.launchTemplate(id)),
      onRender: (route) => pending.push(live.handleRoute(route))
    });
    pending.push(live.handleRoute(shell.getRoute()));
    const settle = async () => { while (pending.length) await pending.shift(); };
    return { G, shell, root, win, live, calls, settle };
  }

  /**
   * @param {string} name
   * @returns {number}
   */
  function seedProject(name) {
    return store.getDb().prepare('INSERT INTO projects (name, path, archived) VALUES (?, ?, 0)').run(name, path.join(tempDir, name)).lastInsertRowid;
  }

  describe('B1: shell navigation and deep links', () => {
    it('entering the shell lists the real projects from /api/projects and loads the fleet templates', async () => {
      seedProject('e2e-alpha');
      seedProject('e2e-beta');
      const { win, root, calls, settle } = mountShell('');
      win.location.hash = '#/projects/1';
      await settle();
      assert.ok(calls.includes('GET /api/projects'));
      assert.ok(calls.includes('GET /api/v6/fleet-templates'));
      assert.match(root.innerHTML, /e2e-alpha/);
      assert.match(root.innerHTML, /e2e-beta/);
    });

    it('every route the shell builds round-trips through parse and hash, including hostile ids', () => {
      const G = loadV6Shell();
      for (const route of [
        { view: 'project', projectId: '42' }, { view: 'fleet', projectId: '42', fleetId: 'f-1' },
        { view: 'conversation', resourceId: '7' }, { view: 'settings', settingsPath: 'platform' },
        { view: 'settings', settingsPath: 'recovery/9' }, { view: 'project', projectId: 'a b/<c>' }
      ]) {
        assert.deepEqual(JSON.parse(JSON.stringify(G.tcV6ParseRoute(G.tcV6RouteHash(route)))), route, JSON.stringify(route));
      }
      assert.deepEqual(JSON.parse(JSON.stringify(G.tcV6ParseRoute('#/projects/%E0%A4%A'))), { view: null }, 'a malformed escape fails closed');
    });

    it('a deep link restores straight into its view on first load', async () => {
      const { root, calls, settle } = mountShell('#/settings/');
      await settle();
      for (const u of ['/api/v6/operating-profiles', '/api/v6/settings/catalog', '/api/v6/walkthroughs?includeUnverified=1']) {
        assert.ok(calls.includes(`GET ${u}`), u);
      }
      assert.match(root.innerHTML, /Operating profiles/);
      assert.match(root.innerHTML, /Full/);
    });
  });

  describe('B1/B3/F1/H2: settings, platform and help views from live data', () => {
    it('the Settings view renders the real profiles, safety floor and settings catalog', async () => {
      const { root, settle } = mountShell('#/settings/');
      await settle();
      assert.match(root.innerHTML, /secretScanning/, 'the safety floor comes from the live A3 module');
      assert.match(root.innerHTML, /telemetryVisible/, 'the settings catalog comes from the live B3 module');
    });

    it('the Platform view renders the real provider contract, Medusa v2 and sandboxing status', async () => {
      const { root, settle } = mountShell('#/settings/platform');
      await settle();
      assert.match(root.innerHTML, /every adapter conforms/);
      assert.match(root.innerHTML, /gitlab/);
      assert.match(root.innerHTML, /medusa-compact-v1/);
      assert.match(root.innerHTML, /shared_uid/);
    });

    it('the Help view renders cited sections from the shipped manual', async () => {
      const { root, calls, settle } = mountShell('#/settings/help');
      await settle();
      assert.ok(calls.some((c) => c.startsWith('GET /api/v6/kb/contextual-help')));
      assert.match(root.innerHTML, /v6-kb-citation/);
    });

    it('the what-if action posts the sample scenario to the live simulator and renders its result', async () => {
      const { root, calls, settle } = mountShell('#/settings/whatif');
      await settle();
      assert.ok(calls.includes('POST /api/v6/whatif/simulate'));
      assert.match(root.innerHTML, /Makespan: <strong>8<\/strong>/);
      assert.match(root.innerHTML, /schema → api → view → review/);
    });

    it('a recovery-console deep link renders the live circuit for a real project', async () => {
      const projectId = seedProject('e2e-recovery');
      const { root, settle } = mountShell(`#/settings/recovery%2F${projectId}`);
      await settle();
      assert.match(root.innerHTML, /Circuit: <strong>closed<\/strong>/);
    });
  });

  describe('B2: native conversation events', () => {
    /**
     * @param {number} projectId
     * @returns {number}
     */
    function seedSession(projectId) {
      return store.getDb().prepare('INSERT INTO sessions (project_id, engine_id) VALUES (?, ?)').run(projectId, 'claude').lastInsertRowid;
    }
    const event = (seq, content, role = 'assistant') => ({ launchId: 'l1', seq, tier: 'A', adapter: 'claude', role, content });

    it('appends monotonic events, replays from a cursor, and renders them through the shell', async () => {
      const projectId = seedProject('e2e-conversation');
      const sessionId = seedSession(projectId);
      const base = `/api/v6/projects/${projectId}/sessions/${sessionId}/conversation/events`;
      assert.equal((await send('POST', base, { body: event(1, 'plan the change', 'user') })).statusCode, 201);
      assert.equal((await send('POST', base, { body: event(2, 'ship it') })).statusCode, 201);
      const all = json(await send('GET', base)).events;
      assert.deepEqual(all.map((e) => e.seq), [1, 2]);
      const tail = json(await send('GET', `${base}?sinceSeq=1`)).events;
      assert.deepEqual(tail.map((e) => e.content), ['ship it'], 'replay resumes after the cursor');

      const G = loadV6Shell();
      const html = G.tcV6ConversationViewMarkup({ project: { id: projectId, name: 'e2e-conversation' }, sessionId, events: all });
      assert.match(html, /plan the change/);
      assert.match(html, /ship it/);
      assert.match(html, /Open Hood/);
    });

    it('refuses a reused sequence number rather than reordering the conversation', async () => {
      const projectId = seedProject('e2e-conversation-seq');
      const sessionId = seedSession(projectId);
      const base = `/api/v6/projects/${projectId}/sessions/${sessionId}/conversation/events`;
      assert.equal((await send('POST', base, { body: event(1, 'first') })).statusCode, 201);
      const dup = await send('POST', base, { body: event(1, 'impostor') });
      assert.ok(dup.statusCode >= 400, dup.body);
      assert.deepEqual(json(await send('GET', base)).events.map((e) => e.content), ['first']);
    });

    it('redacts a credential before it is stored, and a soft delete hides the event from replay', async () => {
      const projectId = seedProject('e2e-conversation-redact');
      const sessionId = seedSession(projectId);
      const base = `/api/v6/projects/${projectId}/sessions/${sessionId}/conversation/events`;
      const secret = 'ghp_' + 'B'.repeat(36);
      const created = json(await send('POST', base, { body: event(1, `token is ${secret}`) }));
      const [stored] = json(await send('GET', base)).events;
      assert.ok(!stored.content.includes(secret), 'the stored conversation never holds the credential');
      assert.equal((await send('DELETE', `${base}/${created.id}`)).statusCode, 200);
      assert.deepEqual(json(await send('GET', base)).events, []);
    });

    it('refuses a non-operator caller and a session that belongs to another project', async () => {
      const a = seedProject('e2e-conversation-a');
      const b = seedProject('e2e-conversation-b');
      const sessionOfA = seedSession(a);
      const anon = await send('POST', `/api/v6/projects/${a}/sessions/${sessionOfA}/conversation/events`, { body: event(1, 'x'), operator: false });
      assert.ok([401, 403].includes(anon.statusCode), anon.body);
      const cross = await send('GET', `/api/v6/projects/${b}/sessions/${sessionOfA}/conversation/events`);
      assert.ok(cross.statusCode >= 400, `a session must not be reachable through another project: ${cross.statusCode}`);
    });
  });

  describe('C1: logical-project hierarchy for a real project', () => {
    it('every attached project has a legacy logical project with its own harness resource', async () => {
      const projectId = seedProject('e2e-hierarchy');
      const res = await send('GET', `/api/v6/logical-projects/lp-${projectId}/hierarchy`);
      assert.equal(res.statusCode, 200, res.body);
      assert.match(res.body, new RegExp(`res-legacy-${projectId}`));
      assert.equal((await send('GET', '/api/v6/logical-projects/lp-nonexistent/hierarchy')).statusCode, 404);
    });
  });
});
