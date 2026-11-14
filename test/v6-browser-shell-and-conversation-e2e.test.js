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
// Tier: `large`. Entering the shell calls GET /api/projects, which scans
// for unregistered project directories in a child process; the medium
// tier's guard forbids starting one, so this file is declared one tier
// slower than its static scan, as test/tiers.json allows.
//
// The conversation journey deep-links the MOUNTED shell to
// `#/resources/:id/conversation`, so the live controller runs its whole
// path: project list -> GET /api/sessions/:name/status -> conversation
// events + attestations -> setDetail. The session is seeded as an active
// `webui` session, which the status route answers from SQLite without
// probing tmux, so no tmux session is needed.

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
    // GET /api/projects scans projectsDir for unregistered directories in a
    // child process; point it at this test's own temp tree so the scan never
    // reads the real ~/Projects (and this file is declared `large`, the tier
    // that may start that child).
    cfg.projectsDir = tempDir;
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
    const headers = Object.assign({ host: 'localhost:3102' }, opts.operator === false ? {} : { 'x-tangleclaw-client': 'dashboard' },
      opts.headers || {});
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
    // Like public/api-helper.js, a failure answers null and leaves the
    // server's own reason on api.lastError / api.lastErrorCode.
    const settle = (res) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        api.lastError = null;
        api.lastErrorCode = null;
        return json(res);
      }
      let data = {};
      try { data = json(res); } catch { /* a non-JSON failure carries no reason */ }
      api.lastError = data.error || `HTTP ${res.statusCode}`;
      api.lastErrorCode = data.code || null;
      return null;
    };
    // Like the page's api(), an optional init sends a method, headers and a body.
    const api = async (url, init) => {
      // A browser read that carries headers (an operator-proofed GET) goes
      // through the same browser-shaped path as a write.
      if (init && init.method === 'GET' && init.headers) {
        calls.push(`GET ${url}`);
        const headers = Object.fromEntries(Object.entries(init.headers).map(([k, v]) => [k.toLowerCase(), v]));
        delete headers['content-type'];
        headers['sec-fetch-site'] = 'same-origin';
        headers.origin = 'http://localhost:3102';
        return settle(await send('GET', url, { headers }));
      }
      if (init && init.method && init.method !== 'GET') {
        calls.push(`${init.method} ${url}`);
        const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
        delete headers['content-type'];
        // A page's own POST carries both: the open gate tells a browser from a
        // local process by them (server.js _looksLikeBrowser), and a write
        // that proves an operator must come from this server's own origin.
        headers['sec-fetch-site'] = 'same-origin';
        headers.origin = 'http://localhost:3102';
        return settle(await send(init.method, url, { body: init.body ? JSON.parse(init.body) : {}, headers }));
      }
      calls.push(`GET ${url}`);
      return settle(await send('GET', url));
    };
    const apiMutate = async (url, method, body) => {
      calls.push(`${method} ${url}`);
      return settle(await send(method, url, { body: body || {} }));
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
    // The page's operator proof (public/api-helper.js tcOperatorProofHeaders):
    // on an open install, the open-install token /api/auth/me hands out.
    const operatorHeaders = async () => {
      const me = await api('/api/auth/me');
      const headers = { 'Content-Type': 'application/json' };
      if (me && me.openInstallToken) headers['X-TC-Open-Token'] = me.openInstallToken;
      return headers;
    };
    const readFileAsBase64 = async (file) => Buffer.from(file.content).toString('base64');
    const live = G.tcV6CreateLiveController({ getShell: () => shell, api, apiMutate, operatorHeaders, readFileAsBase64, storage: null });
    shell = G.tcCreateV6Shell(doc, {
      root, window: win,
      onLaunchTemplate: (id) => pending.push(live.launchTemplate(id)),
      onRender: (route) => pending.push(live.handleRoute(route)),
      onSendChat: (text) => pending.push(live.sendChat(text)),
      onChangeDelegate: (nodeId, projectId) => pending.push(live.changeDelegate(nodeId, projectId)),
      onRefreshChat: () => pending.push(live.refresh()),
      onAttachFiles: (files) => pending.push(live.attachFiles(files)),
      onRemoveAttachment: (i) => pending.push(live.removeAttachment(i)),
      storage: null
    });
    pending.push(live.handleRoute(shell.getRoute()));
    const settle = async () => { while (pending.length) await pending.shift(); };
    return { G, shell, root, win, live, calls, settle, doc };
  }

  /**
   * @param {string} name
   * @returns {number}
   */
  function seedProject(name) {
    fs.mkdirSync(path.join(tempDir, name), { recursive: true });
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

    it('a conversation deep link runs the mounted shell\'s live controller end to end (PRR-B R1)', async () => {
      const projectId = seedProject('e2e-conversation-live');
      const sessionId = store.getDb().prepare(
        "INSERT INTO sessions (project_id, engine_id, status, session_mode, started_at) VALUES (?, 'claude', 'active', 'webui', datetime('now'))"
      ).run(projectId).lastInsertRowid;
      const base = `/api/v6/projects/${projectId}/sessions/${sessionId}/conversation/events`;
      assert.equal((await send('POST', base, { body: event(1, 'what changed?', 'user') })).statusCode, 201);
      assert.equal((await send('POST', base, { body: event(2, 'the landing race is fixed') })).statusCode, 201);

      const { root, calls, settle } = mountShell(`#/resources/${projectId}/conversation`);
      await settle();
      assert.ok(calls.includes('GET /api/projects'));
      assert.ok(calls.includes('GET /api/sessions/e2e-conversation-live/status'), JSON.stringify(calls));
      assert.ok(calls.includes(`GET ${base}`), 'the controller fetched the live events');
      assert.ok(calls.includes(`GET /api/v6/projects/${projectId}/sessions/${sessionId}/attestations`));
      assert.match(root.innerHTML, /what changed\?/);
      assert.match(root.innerHTML, /the landing race is fixed/);
      assert.match(root.innerHTML, /Open Hood/);
    });

    it('a conversation deep link for a project with no live session renders the honest empty state', async () => {
      const projectId = seedProject('e2e-conversation-idle');
      const { root, calls, settle } = mountShell(`#/resources/${projectId}/conversation`);
      await settle();
      assert.ok(calls.includes('GET /api/sessions/e2e-conversation-idle/status'));
      assert.ok(!calls.some((c) => c.includes('/conversation/events')), 'no session, so no event fetch');
      assert.match(root.innerHTML, /e2e-conversation-idle/);
    });

    it('a project route opens the Project Delegate Chat with its PM, and a refused send shows the server\'s reason (#3047)', async () => {
      const pmId = seedProject('e2echat-PM');
      seedProject('e2echat-A');
      store.getDb().prepare(
        "INSERT INTO sessions (project_id, engine_id, status, session_mode, started_at) VALUES (?, 'claude', 'active', 'webui', datetime('now'))"
      ).run(pmId);
      const { root, calls, settle, live, doc } = mountShell('#/projects/e2echat');
      await settle();
      assert.ok(calls.includes('GET /api/sessions/e2echat-PM/status'), JSON.stringify(calls));
      assert.ok(calls.includes('GET /api/sessions/e2echat-PM/peek?lines=80'));
      assert.match(root.innerHTML, /Talking to: <strong>e2echat-PM<\/strong> \(#\d+\) · Designated Project Delegate/);
      assert.match(root.innerHTML, /<option value="\d+" selected>e2echat-PM<\/option>/);
      assert.match(root.innerHTML, /Could not read live output/, 'a Web UI session has no pane to peek');

      const input = doc.getElementById('v6ChatInput');
      input.value = 'status please';
      input.dispatch('input');
      doc.getElementById('v6ChatForm').dispatch('submit');
      await settle();
      assert.ok(calls.includes('POST /api/sessions/e2echat-PM/command'));
      // The seeded session has no bound launch, so the command route's own
      // startup admission gate refuses first; the chat shows its reason.
      assert.match(root.innerHTML, /is-error[^>]*>Not sent: This session&#39;s launch is not yet ready \(needs-attention\)\.</);
      assert.ok(!calls.some((c) => c.startsWith('POST') && c.endsWith('/conversation/events')), 'a refused message is not recorded');
      assert.match(root.innerHTML, /<textarea id="v6ChatInput"[^>]*>status please<\/textarea>/);
      assert.equal(typeof live.sendChat, 'function');
    });

    it('a file attached in the chat is saved into the project\'s secrets store through the real route, and its chip shows the saved path (#3053)', async () => {
      const projectId = seedProject('e2e-chat-upload');
      store.getDb().prepare(
        "INSERT INTO sessions (project_id, engine_id, status, session_mode, started_at) VALUES (?, 'claude', 'active', 'webui', datetime('now'))"
      ).run(projectId);
      const { root, calls, settle, doc } = mountShell(`#/resources/${projectId}/conversation`);
      await settle();
      const input = doc.getElementById('v6ChatFileInput');
      input.files = [{ name: 'Screen Shot 1.png', size: 9, content: 'PNG-BYTES' }];
      input.dispatch('change');
      await settle();
      assert.ok(calls.includes('POST /api/sessions/e2e-chat-upload/secure-clipboard'), JSON.stringify(calls));
      assert.match(root.innerHTML, /v6-chat-chip is-ready" title="\.tangleclaw\/secrets\/Screen-Shot-1\.png"/);
      const saved = path.join(tempDir, 'e2e-chat-upload', '.tangleclaw', 'secrets', 'Screen-Shot-1.png');
      assert.equal(fs.readFileSync(saved, 'utf8'), 'PNG-BYTES');
      assert.equal(fs.statSync(saved).mode & 0o777, 0o600, 'saved readable by its owner only');
    });

    it('an attachment named like a file already in the secrets store gets a new name through the real route, leaving the old file intact (INT R-Gate)', async () => {
      const projectId = seedProject('e2e-chat-upload-dup');
      store.getDb().prepare(
        "INSERT INTO sessions (project_id, engine_id, status, session_mode, started_at) VALUES (?, 'claude', 'active', 'webui', datetime('now'))"
      ).run(projectId);
      const dir = path.join(tempDir, 'e2e-chat-upload-dup', '.tangleclaw', 'secrets');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'image.png'), 'ORIGINAL', { mode: 0o600 });
      const { root, calls, settle, doc } = mountShell(`#/resources/${projectId}/conversation`);
      await settle();
      const input = doc.getElementById('v6ChatFileInput');
      input.files = [{ name: 'image.png', size: 3, content: 'NEW' }];
      input.dispatch('change');
      await settle();
      assert.ok(calls.includes('GET /api/sessions/e2e-chat-upload-dup/secure-clipboard'), 'the listing was read');
      assert.match(root.innerHTML, /v6-chat-chip is-ready" title="\.tangleclaw\/secrets\/image-2\.png"/);
      assert.equal(fs.readFileSync(path.join(dir, 'image.png'), 'utf8'), 'ORIGINAL', 'the existing file was not overwritten');
      assert.equal(fs.readFileSync(path.join(dir, 'image-2.png'), 'utf8'), 'NEW');
    });

    it('the real B2 route accepts the event the chat records, and the next seq counts deleted events (#3047)', async () => {
      const projectId = seedProject('e2e-chat-record');
      const sessionId = seedSession(projectId);
      const base = `/api/v6/projects/${projectId}/sessions/${sessionId}/conversation/events`;
      assert.equal((await send('POST', base, { body: event(1, 'old') })).statusCode, 201);
      const created = json(await send('GET', base)).events[0];
      assert.equal((await send('DELETE', `${base}/${created.id}`)).statusCode, 200);
      const all = json(await send('GET', `${base}?includeDeleted=1`)).events;
      assert.deepEqual(all.map((e) => e.seq), [1], 'the deleted event still holds seq 1');
      const res = await send('POST', base, {
        body: { launchId: 'v6-chat-ui', seq: 2, tier: 'A', adapter: 'v6-chat-ui', role: 'user', content: 'from the chat' }
      });
      assert.equal(res.statusCode, 201, res.body);
      assert.equal((await send('POST', base, {
        body: { launchId: 'v6-chat-ui', seq: 1, tier: 'A', adapter: 'v6-chat-ui', role: 'user', content: 'reuse' }
      })).statusCode, 409, 'reusing a deleted event\'s seq is a conflict, which is why the chat reads deleted events');
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
