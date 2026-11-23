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
const { execFileSync } = require('node:child_process');
const store = require('../lib/store');
const { handleRequest } = require('../server');
const { makeDocument, withIdParsingInnerHTML } = require('./_mini-dom');
const loadApiHelperGlobals = require('./_api-helper-globals');
const { initRepo } = require('./_temp-repo');

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
  let prevHome;

  before(() => {
    prevBase = store._getBasePath();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-e2e-shell-'));
    store.close();
    store._setBasePath(tempDir);
    store.init();
    // #3085: the shell now loads GET /api/usage/windows, which scans each
    // engine's transcripts under the home directory. Like projectsDir below,
    // point it at this test's own temp tree, so it never reads (or waits on)
    // the real ~/.claude, ~/.codex and ~/.gemini of the machine running it.
    prevHome = process.env.HOME;
    process.env.HOME = tempDir;
  });

  after(() => {
    if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
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
      onRenameProject: (oldName, newName, opts) => pending.push(live.renameProject(oldName, newName, opts)),
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
      // #3166: always the deep depth now, whether or not Under the Hood is open --
      // a closed drawer used to read only the shallow 80-line depth, which silently
      // truncated #v6ChatStream itself since extractLiveTurns parses chat turns from
      // this same read, not just what the drawer's own raw panel shows.
      assert.ok(calls.includes('GET /api/sessions/e2echat-PM/peek?lines=2000'));
      // Restated by #3059: the lead-in and the mode are screen-reader text in the compact toolbar.
      assert.match(root.innerHTML, /Talking to: <\/span><strong>e2echat-PM<\/strong> \(#\d+\)<span class="sr-only"> · Designated Project Delegate<\/span>/);
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

    it('the chat header shows the project\'s own tag and dirty branch from the real /api/projects row (#3057)', async () => {
      const name = 'e2e-badges';
      const pid = seedProject(name);
      const dir = path.join(tempDir, name);
      const git = (...args) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: dir, stdio: 'ignore' });
      initRepo(dir, ['-b', 'feat/e2e-badge']);
      git('commit', '--allow-empty', '-q', '-m', 'init');
      git('tag', 'v9.9.9');
      fs.writeFileSync(path.join(dir, 'uncommitted.txt'), 'x');
      const row = JSON.parse((await send('GET', '/api/projects')).body).projects.find((p) => p.name === name);
      assert.equal(row.git.branch, 'feat/e2e-badge', 'the field the badge reads');
      assert.equal(row.git.latestTag, 'v9.9.9');
      assert.equal(row.git.dirty, true);
      const { root, settle } = mountShell(`#/resources/${pid}/conversation`);
      await settle();
      const header = root.innerHTML.slice(root.innerHTML.indexOf('class="v6-chat-talking-to"'), root.innerHTML.indexOf('class="v6-chat-actions"'));
      assert.match(header, new RegExp(`<span class="v6-chat-version-badge"[^>]*>${(row.version || 'v9.9.9').replace(/\./g, '\\.')}</span>`));
      assert.match(header, /<span class="v6-chat-git-badge is-dirty"[^>]*>⎇ feat\/e2e-badge\*<\/span>/);
    });

    it('with the sidebar hidden the chat offers » Show Fleet, and it brings the sidebar back (#3057)', async () => {
      const pid = seedProject('e2e-show-fleet');
      const { root, settle, shell, doc } = mountShell(`#/resources/${pid}/conversation`);
      await settle();
      assert.doesNotMatch(root.innerHTML, /id="v6ChatShowFleet"/);
      shell.toggleSidebar(true);
      await settle();
      assert.match(root.innerHTML, /<button type="button" id="v6ChatShowFleet"/);
      assert.match(root.innerHTML, /<button type="button" id="v6SidebarExpand"/);
      doc.getElementById('v6ChatShowFleet').dispatch('click');
      await settle();
      assert.equal(shell.isSidebarCollapsed(), false);
      assert.doesNotMatch(root.innerHTML, /id="v6ChatShowFleet"/);
    });

    it('a send the real command route refuses does not leave the chat reading as Working (#3057)', async () => {
      const pid = seedProject('e2e-busy-refused');
      store.getDb().prepare(
        "INSERT INTO sessions (project_id, engine_id, status, session_mode, started_at) VALUES (?, 'claude', 'active', 'webui', datetime('now'))"
      ).run(pid);
      const { root, settle, calls, doc } = mountShell(`#/resources/${pid}/conversation`);
      await settle();
      // #3167, Ruling A864: this seeded row's real GET /api/sessions/:name/status
      // answers idle: false with idleReason: null (no reachable pane probe at all,
      // not "it is busy") -- isSessionStatusBusy requires idleReason to be one of
      // the 3 genuinely-working reasons, so this correctly reads idle throughout.
      assert.doesNotMatch(root.innerHTML, /v6-chat-activity is-busy/);
      const input = doc.getElementById('v6ChatInput');
      input.value = 'are you there?';
      input.dispatch('input');
      doc.getElementById('v6ChatForm').dispatch('submit');
      await settle();
      assert.ok(calls.includes('POST /api/sessions/e2e-busy-refused/command'));
      assert.match(root.innerHTML, /is-error[^>]*>Not sent:/);
      assert.match(root.innerHTML, /<p id="v6ChatActivity" class="v6-chat-activity" aria-live="polite"><\/p>/);
    });

    it('a project route marks its delegate lane in the sidebar and shows the one-row icon toolbar (#3059)', async () => {
      const pmId = seedProject('e2eside-PM');
      seedProject('e2eside-A');
      store.getDb().prepare(
        "INSERT INTO sessions (project_id, engine_id, status, session_mode, started_at) VALUES (?, 'claude', 'active', 'webui', datetime('now'))"
      ).run(pmId);
      const { root, settle } = mountShell('#/projects/e2eside');
      await settle();
      assert.match(root.innerHTML, /Talking to: <\/span><strong>e2eside-PM<\/strong>/, 'the chat resolved to the PM delegate');
      const active = [...root.innerHTML.matchAll(/<a class="v6-shell-member-link[^"]*\bis-active"\s+aria-current="page"[^>]*href="([^"]+)"/g)].map((x) => x[1]);
      assert.deepEqual(active, [`#/resources/${pmId}/conversation`], 'exactly the delegate lane is marked');
      assert.ok(root.classList.contains('v6-shell-root--chat'), 'the route and group headings are hidden in the chat');
      const header = root.innerHTML.slice(root.innerHTML.indexOf('<header class="v6-chat-header">'), root.innerHTML.indexOf('</header>'));
      assert.match(header, /v6-open-hood" href="\/session\/e2eside-PM" title="Open Hood \(Live Terminal\)" aria-label="Open Hood \(Live Terminal\)"/);
      assert.match(header, /id="v6ChatRefresh"[^>]*title="Refresh conversation" aria-label="Refresh conversation"/);
      assert.match(header, /id="v6ChatSettings"[^>]*title="Project Settings" aria-label="Project Settings"/);
    });

    it('a chat shows the server\'s real telemetry inside its one header row, each chip with a tip (#3063)', async () => {
      const pid = seedProject('e2e-onerow');
      store.getDb().prepare(
        "INSERT INTO sessions (project_id, engine_id, status, session_mode, started_at) VALUES (?, 'claude', 'active', 'webui', datetime('now'))"
      ).run(pid);
      const { root, settle, calls } = mountShell(`#/resources/${pid}/conversation`);
      await settle();
      assert.ok(calls.some((c) => /\/api\/v6\/projects\/[^/]+\/telemetry\?scope=global$/.test(c)), JSON.stringify(calls));
      const html = root.innerHTML;
      assert.equal((html.match(/class="v6-telemetry-header"/g) || []).length, 1, 'one bar');
      const header = html.slice(html.indexOf('<header class="v6-chat-header">'), html.indexOf('</header>'));
      assert.ok(header.indexOf('class="v6-chat-identity"') < header.indexOf('class="v6-telemetry-header"'));
      assert.ok(header.indexOf('class="v6-telemetry-header"') < header.indexOf('class="v6-chat-actions"'));
      const version = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'version.json'), 'utf8')).version;
      // Restated by #3079: Active sessions, Health and Version left the header for the footer status bar.
      const footer = html.slice(html.indexOf('<footer class="v6-shell-watermark has-status">'));
      assert.ok(footer.length > 0 && footer.includes('id="v6ShellStatusBar"'), 'the footer is the status bar');
      assert.match(footer, /<span class="v6-telemetry-chip is-observed" title="Active sessions: \d+ — live sessions on this TangleClaw server \(observed\)">/);
      assert.match(footer, new RegExp(`<span class="v6-telemetry-chip is-observed" title="Version: ${version.replace(/\./g, '\\.')} — the TangleClaw version this server runs \\(observed\\)">`));
      assert.match(footer, /<span class="v6-telemetry-chip is-estimated" title="Health: [^"]+ — server health \(estimated\)">/);
      assert.doesNotMatch(header, /title="(Active sessions|Health|Version):/);
      assert.match(header, /<span class="v6-telemetry-chip is-unavailable" title="Tokens: no reading yet — model tokens used \(unavailable\)">/);
      assert.ok(root.classList.contains('v6-shell-root--chat'), 'so the unavailable chips are hidden by the chat-scoped rule');
    });

    it('the 3-engine usage meter reads the real usage route and always shows Claude, Codex and AGY (#3085)', async () => {
      seedProject('e2e-usage');
      const { root, calls, settle } = mountShell('#/projects/1');
      await settle();
      // The meter loads beside the route, from a route that scans transcripts: wait for it to land.
      for (let i = 0; i < 200 && !/id="v6EngineUsageMeter"/.test(root.innerHTML); i++) await new Promise((r) => setTimeout(r, 50));
      assert.ok(calls.includes('GET /api/usage/windows'), JSON.stringify(calls));
      assert.ok(calls.includes('GET /api/usage/sessions'));
      const html = root.innerHTML;
      assert.match(html, /<div id="v6EngineUsageSlot" class="v6-usage-slot"><button type="button" id="v6EngineUsageMeter"/);
      for (const engine of ['claude', 'codex', 'antigravity']) assert.match(html, new RegExp(`class="v6-usage-pill [^"]*" data-engine="${engine}"`));
      assert.match(html, /<span class="v6-usage-label">AGY<\/span>/);
    });

    it('the Sprint & Cars mode reads the real sprint route, and says plainly when this server does not serve it yet (#3086)', async () => {
      seedProject('e2e-modes');
      const { root, calls, settle, doc, shell } = mountShell('#/projects/1');
      await settle();
      assert.match(root.innerHTML, /<div id="v6WorkspaceModeBar" class="v6-workspace-mode-bar" role="tablist" aria-label="Workspace">/);
      assert.match(root.innerHTML, /id="v6ShellWizardOpenBtn"/);
      doc.getElementById('v6WorkspaceMode-sprint').dispatch('click');
      // The test DOM keeps ids, not inner markup, across a redraw: read the panel element, else the last drawing of it.
      const panel = () => {
        const painted = doc.getElementById('v6WorkspacePanel').innerHTML;
        if (painted) return painted;
        const drawn = /<section id="v6WorkspacePanel" class="v6-workspace-panel" role="tabpanel"\s+aria-labelledby="v6WorkspaceMode-sprint">([\s\S]*?)<\/section>/.exec(root.innerHTML);
        return drawn ? drawn[1] : '';
      };
      // The route is mounted by V630-W1-B; either merge order must read cleanly, so wait for the loading line to go.
      for (let i = 0; i < 300 && (!panel() || /Loading…/.test(panel())); i++) await new Promise((r) => setTimeout(r, 50));
      assert.equal(shell.getWorkspaceMode(), 'sprint', 'a redraw on the same route keeps the mode');
      assert.ok(calls.includes('GET /api/sprint-waves'), JSON.stringify(calls));
      assert.doesNotMatch(panel(), /Loading…/);
      assert.match(panel(), /<h2 class="v6-workspace-panel-title">Sprint &amp; Cars<\/h2>/);
      assert.match(panel(), /Not available on this server yet\.|sprint-wave-board|v6-workspace-list|No cars are on the board yet\./);
    });

    it('the sidebar\'s four icons and fleet picker work over the real project list (#3068)', async () => {
      seedProject('e2epick-PM');
      seedProject('e2epick-A');
      seedProject('e2eother-PM');
      const { root, settle, doc } = mountShell('#/projects/e2epick');
      await settle();
      for (const id of ['v6SidebarCollapse', 'v6SidebarModeFleet', 'v6SidebarSearchToggle', 'v6SidebarFutureSlot']) {
        assert.match(root.innerHTML, new RegExp(`id="${id}"`), id);
      }
      const picker = root.innerHTML.slice(root.innerHTML.indexOf('<select id="v6FilterFleet"'), root.innerHTML.indexOf('</select>', root.innerHTML.indexOf('<select id="v6FilterFleet"')));
      const pick = /<option value="([^"]+)">e2epick<\/option>/.exec(picker);
      assert.ok(pick, `the real e2epick group is offered: ${picker.slice(0, 400)}`);
      assert.match(picker, />Workspace Projects</, 'a lone project lands in the standalone group, offered too');
      const el = doc.getElementById('v6FilterFleet');
      el.value = pick[1];
      el.dispatch('change');
      await settle();
      assert.match(root.innerHTML, /e2epick-PM/);
      assert.doesNotMatch(root.innerHTML.slice(root.innerHTML.indexOf('class="v6-shell-tree"')), /e2eother-PM/, 'only the picked fleet is in the tree');
    });

    it('renaming the chat\'s target from its header goes through the real route and shows everywhere at once (#3071)', async () => {
      const pid = seedProject('e2e-rename-old');
      const { root, settle, calls, doc, live } = mountShell(`#/resources/${pid}/conversation`);
      await settle();
      assert.match(root.innerHTML, /<strong>e2e-rename-old<\/strong>/);
      doc.getElementById('v6ChatRename').dispatch('click');
      doc.getElementById('v6ChatRenameInput').value = 'e2e-rename-new';
      const pending = live.renameProject('e2e-rename-old', 'e2e-rename-new');
      await pending;
      await settle();
      assert.ok(calls.includes('PATCH /api/projects/e2e-rename-old'), JSON.stringify(calls));
      assert.ok(fs.existsSync(path.join(tempDir, 'e2e-rename-new')), 'the real route moved the directory');
      assert.equal(fs.existsSync(path.join(tempDir, 'e2e-rename-old')), false);
      assert.match(root.innerHTML, /Talking to: <\/span><strong>e2e-rename-new<\/strong>/, 'the header shows the new name');
      assert.match(root.innerHTML, /e2e-rename-new \(\d+\)/, 'and the sidebar row');
      assert.match(root.innerHTML, /is-ok[^>]*>Renamed e2e-rename-old to e2e-rename-new\./);
    });

    it('the real route refuses to rename a project with a live session, and the chat shows why (#3071)', async () => {
      const pid = seedProject('e2e-rename-live');
      store.getDb().prepare(
        "INSERT INTO sessions (project_id, engine_id, status, session_mode, started_at) VALUES (?, 'claude', 'active', 'webui', datetime('now'))"
      ).run(pid);
      const { root, settle, live } = mountShell(`#/resources/${pid}/conversation`);
      await settle();
      assert.match(root.innerHTML, /id="v6ChatRename"[^>]*disabled>/, 'the pencil is off for a live session');
      await live.renameProject('e2e-rename-live', 'e2e-rename-other');
      await settle();
      assert.match(root.innerHTML, /is-error[^>]*>Not renamed: Cannot rename while a session is active</);
      assert.ok(fs.existsSync(path.join(tempDir, 'e2e-rename-live')), 'nothing moved');
    });

    it('the history panel lists, searches across the fleet and opens real saved sessions, and references one in chat (#3066)', async () => {
      const continuity = require('../lib/continuity');
      const pmId = seedProject('e2ehist-PM');
      seedProject('e2ehist-A');
      store.getDb().prepare(
        "INSERT INTO sessions (project_id, engine_id, status, session_mode, started_at) VALUES (?, 'claude', 'active', 'webui', datetime('now'))"
      ).run(pmId);
      continuity.writeWrapSummary(path.join(tempDir, 'e2ehist-PM'), '41', { meta: { date: '2026-11-10' }, sections: { Decisions: 'Ship the history panel on Friday.' } });
      continuity.writeWrapSummary(path.join(tempDir, 'e2ehist-A'), '42', { meta: { date: '2026-11-12' }, sections: { Decisions: 'Review the history panel.' } });
      const { root, settle, doc, live, calls } = mountShell(`#/resources/${pmId}/conversation`);
      await settle();
      doc.getElementById('v6SidebarFutureSlot').dispatch('click');
      await live.loadHistory({ scope: 'member', kind: 'summaries', q: '' });
      await settle();
      assert.ok(calls.includes('GET /api/continuity/e2ehist-PM/sessions'), JSON.stringify(calls));
      assert.match(root.innerHTML, /<span class="v6-history-who">e2ehist-PM<\/span> session #41/);
      await live.loadHistory({ scope: 'fleet', kind: 'summaries', q: 'history panel' });
      await settle();
      assert.ok(calls.includes('GET /api/continuity/e2ehist-A/search?q=history%20panel'), 'the fleet search asked each member');
      assert.match(root.innerHTML, /e2ehist-PM<\/span> session #41/);
      assert.match(root.innerHTML, /e2ehist-A<\/span> session #42/);
      await live.openHistorySession({ member: 'e2ehist-PM', sid: '41', q: '' });
      await settle();
      assert.match(root.innerHTML, /<strong>Decisions<\/strong><div>Ship the history panel on Friday\.<\/div>/);
      doc.getElementById('v6HistoryReference').dispatch('click');
      assert.match(root.innerHTML, /<textarea id="v6ChatInput"[^>]*>\[e2ehist-PM session #41 · 2026-11-10\] Ship the history panel on Friday\.<\/textarea>/);
    });

    it('Open Hood\'s /session/<name> link is served by the real handler (#3073)', async () => {
      const pid = seedProject('e2e-hood');
      const { root, settle } = mountShell(`#/resources/${pid}/conversation`);
      await settle();
      const href = /v6-open-hood" href="([^"]+)"/.exec(root.innerHTML)[1];
      assert.equal(href, '/session/e2e-hood');
      const page = await send('GET', href, { operator: false });
      assert.equal(page.statusCode, 200);
      assert.match(page.body, /session\.js/, 'the session page itself, which reads the name from this path');
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

    it('a recorded switchboard wake is shown Under the Hood, not as the operator, and the Medusa indicator reads the real status (#3076)', async () => {
      const projectId = seedProject('e2e-medusa-on');
      fs.mkdirSync(path.join(tempDir, 'e2e-medusa-on', '.tangleclaw'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'e2e-medusa-on', '.tangleclaw', 'project.json'), JSON.stringify({ medusaEnabled: true }));
      const sessionId = store.getDb().prepare(
        "INSERT INTO sessions (project_id, engine_id, status, session_mode, started_at) VALUES (?, 'claude', 'active', 'webui', datetime('now'))"
      ).run(projectId).lastInsertRowid;
      const base = `/api/v6/projects/${projectId}/sessions/${sessionId}/conversation/events`;
      assert.equal((await send('POST', base, { body: event(1, 'what is next?', 'user') })).statusCode, 201);
      assert.equal((await send('POST', base, { body: event(2, '[TangleClaw Switchboard] You have 1 unread Medusa message(s): tc message read.', 'user') })).statusCode, 201);
      const status = json(await send('GET', '/api/sessions/e2e-medusa-on/medusa/status'));
      assert.equal(status.enabled, true, 'the real route reports the opt-in');

      const { root, calls, settle } = mountShell(`#/resources/${projectId}/conversation`);
      await settle();
      assert.ok(calls.includes('GET /api/sessions/e2e-medusa-on/medusa/status'), JSON.stringify(calls));
      const html = root.innerHTML;
      const stream = html.slice(html.indexOf('id="v6ChatStream"'), html.indexOf('id="v6ChatUnderHood"'));
      assert.match(stream, /what is next\?/);
      assert.doesNotMatch(stream, /TangleClaw Switchboard/);
      const hood = html.slice(html.indexOf('id="v6ChatSwitchboard"'), html.indexOf('id="v6ChatPeek"'));
      assert.match(hood, /<li class="v6-chat-switchboard-item is-in">[\s\S]*\[TangleClaw Switchboard\] You have 1 unread Medusa message\(s\)/);
      // No listener runs in the test server: the real status is off with nothing unread, so the badge is @.
      assert.match(html, new RegExp(`<button type="button" id="v6ChatMedusa" class="v6-chat-medusa is-${status.state}"`));
      assert.match(html, /<span id="v6ChatMedusaBadge" class="v6-chat-medusa-badge" aria-hidden="true">@<\/span>/);
    });

    it('a project that has not turned Medusa on shows no indicator (#3076)', async () => {
      const projectId = seedProject('e2e-medusa-off');
      store.getDb().prepare(
        "INSERT INTO sessions (project_id, engine_id, status, session_mode, started_at) VALUES (?, 'claude', 'active', 'webui', datetime('now'))"
      ).run(projectId);
      const { root, calls, settle } = mountShell(`#/resources/${projectId}/conversation`);
      await settle();
      assert.ok(calls.includes('GET /api/sessions/e2e-medusa-off/medusa/status'));
      assert.equal(json(await send('GET', '/api/sessions/e2e-medusa-off/medusa/status')).enabled, false);
      assert.match(root.innerHTML, /<span id="v6ChatMedusaSlot" class="v6-chat-medusa-slot"><\/span>/);
      assert.doesNotMatch(root.innerHTML, /id="v6ChatMedusa"/);
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

  describe('Car V658-W1-C: chat stream scroll-pin behavior in the live mounted shell (#3200)', () => {
    /**
     * A LIVE (webui) session, so the shell's live controller actually polls
     * conversation events — the same shape B2's own "live controller end to
     * end" test above uses.
     * @param {number} projectId
     * @returns {number}
     */
    function seedLiveSession(projectId) {
      return store.getDb().prepare(
        "INSERT INTO sessions (project_id, engine_id, status, session_mode, started_at) VALUES (?, 'claude', 'active', 'webui', datetime('now'))"
      ).run(projectId).lastInsertRowid;
    }
    const event = (seq, content, role = 'assistant') => ({ launchId: 'l1', seq, tier: 'A', adapter: 'claude', role, content });

    /** Gives `#v6ChatStream` the scroll-geometry properties this mini-DOM has no real layout for. */
    function withStreamGeometry(streamEl, { scrollTop, scrollHeight, clientHeight }) {
      streamEl.scrollTop = scrollTop;
      streamEl.scrollHeight = scrollHeight;
      streamEl.clientHeight = clientHeight;
    }

    /**
     * The exact `v6TreeRename-m<pi>-<fi>-<mi>` suffix for ONE project's own
     * sidebar member row, found by its real DB id rather than assumed to be
     * `p0`. This DB is shared across the whole test file (seeded once in
     * `before()`), so a project's positional index among the sidebar tree's
     * fleet/workspace groups depends on how many OTHER projects earlier
     * tests have already seeded, and (`synthesizeTreeFromProjects`) on
     * whether this project's name happens to share a dash-prefix with any
     * of them — `p0` is neither stable in isolation nor guaranteed to be
     * THIS project rather than a same-prefix group bulk-renaming unrelated
     * projects together. The per-MEMBER button found here always renames
     * exactly this one project via `options.onRenameProject` directly,
     * never the bulk `renameFleetMembers` path a project-level button can
     * trigger.
     * @param {object} root
     * @param {number} projectId
     * @returns {string} e.g. `"m2-0-1"`
     */
    function findMemberRenameIdSuffix(root, projectId) {
      const re = new RegExp(`id="v6TreeLink-(m[0-9]+-[0-9]+-[0-9]+)" data-rename-dblclick="m:${projectId}"`);
      const found = re.exec(root.innerHTML);
      assert.ok(found, `no sidebar member row found for project ${projectId} — is it even in the tree?`);
      return found[1];
    }

    it('pins #v6ChatStream to the bottom on initial conversation open — #v6ChatJumpLatest starts hidden', async () => {
      const projectId = seedProject('e2e-3200-initial-pin');
      const sessionId = seedLiveSession(projectId);
      const base = `/api/v6/projects/${projectId}/sessions/${sessionId}/conversation/events`;
      await send('POST', base, { body: event(1, 'hello', 'user') });
      await send('POST', base, { body: event(2, 'hi there') });
      const { root, settle } = mountShell(`#/resources/${projectId}/conversation`);
      await settle();
      assert.match(root.innerHTML, /id="v6ChatJumpLatest" class="v6-chat-jump-latest" hidden/, 'pinned by default, so the jump-to-latest pill starts hidden');
    });

    it('disengages the pin when the operator scrolls up more than 4px — #v6ChatJumpLatest becomes visible', async () => {
      const projectId = seedProject('e2e-3200-unpin');
      const sessionId = seedLiveSession(projectId);
      const base = `/api/v6/projects/${projectId}/sessions/${sessionId}/conversation/events`;
      await send('POST', base, { body: event(1, 'hello', 'user') });
      await send('POST', base, { body: event(2, 'hi there') });
      const { root, doc, settle } = mountShell(`#/resources/${projectId}/conversation`);
      await settle();
      const streamEl = doc.getElementById('v6ChatStream');
      assert.ok(streamEl, 'the stream must be mounted');
      withStreamGeometry(streamEl, { scrollTop: 100, scrollHeight: 1000, clientHeight: 400 });
      streamEl.dispatch('scroll'); // establishes lastStreamScrollTop = 100, still far from bottom
      withStreamGeometry(streamEl, { scrollTop: 50, scrollHeight: 1000, clientHeight: 400 }); // scrolled UP by 50px
      streamEl.dispatch('scroll');
      assert.equal(doc.getElementById('v6ChatJumpLatest').hidden, false, 'scrolling up by > 4px must reveal the jump-to-latest pill');
    });

    it('re-pins when #v6ChatJumpLatest is clicked', async () => {
      const projectId = seedProject('e2e-3200-repin');
      const sessionId = seedLiveSession(projectId);
      const base = `/api/v6/projects/${projectId}/sessions/${sessionId}/conversation/events`;
      await send('POST', base, { body: event(1, 'hello', 'user') });
      await send('POST', base, { body: event(2, 'hi there') });
      const { doc, settle } = mountShell(`#/resources/${projectId}/conversation`);
      await settle();
      const streamEl = doc.getElementById('v6ChatStream');
      withStreamGeometry(streamEl, { scrollTop: 500, scrollHeight: 1000, clientHeight: 400 });
      streamEl.dispatch('scroll');
      withStreamGeometry(streamEl, { scrollTop: 50, scrollHeight: 1000, clientHeight: 400 });
      streamEl.dispatch('scroll');
      assert.equal(doc.getElementById('v6ChatJumpLatest').hidden, false, 'unpinned first, so the click below has something to undo');
      doc.getElementById('v6ChatJumpLatest').dispatch('click');
      assert.equal(doc.getElementById('v6ChatJumpLatest').hidden, true, 'clicking the pill must re-pin and hide itself again');
    });

    it('re-pins on switching to a different session\'s conversation, even if the previous one was left unpinned', async () => {
      const projectA = seedProject('e2e-3200-switch-a');
      const projectB = seedProject('e2e-3200-switch-b');
      const sessionA = seedLiveSession(projectA);
      seedLiveSession(projectB);
      const baseA = `/api/v6/projects/${projectA}/sessions/${sessionA}/conversation/events`;
      await send('POST', baseA, { body: event(1, 'hello from a', 'user') });
      await send('POST', baseA, { body: event(2, 'hi from a') });
      const { win, doc, settle } = mountShell(`#/resources/${projectA}/conversation`);
      await settle();
      const streamElA = doc.getElementById('v6ChatStream');
      withStreamGeometry(streamElA, { scrollTop: 500, scrollHeight: 1000, clientHeight: 400 });
      streamElA.dispatch('scroll');
      withStreamGeometry(streamElA, { scrollTop: 50, scrollHeight: 1000, clientHeight: 400 });
      streamElA.dispatch('scroll');
      assert.equal(doc.getElementById('v6ChatJumpLatest').hidden, false, 'project A left unpinned');
      win.location.hash = `#/resources/${projectB}/conversation`;
      await settle();
      assert.equal(doc.getElementById('v6ChatJumpLatest').hidden, true, 'a different conversation always opens pinned, regardless of how the previous one was left');
    });

    // R2 (PRRA-R1-V658-W1C-PR3220-4C2BB46F-REVISE BLOCKING 2b/2c): render()
    // already wraps every redraw in captureViewState()/restoreViewState()
    // (confirmed by reading public/v6-shell.js directly, lines ~9492/9611
    // on this branch's base) -- opening/canceling the sidebar's inline
    // rename form calls render() the same way any other state change does,
    // so #v6ChatStream's pin state and exact scrollTop already survive it
    // today, independent of sibling Car V658-W1-B's own new
    // createChatScrollCoordinator work. These tests hold a real, already-
    // true property, not a vacuous one.
    it('preserves #v6ChatStream\'s bottom pin across opening and canceling the sidebar rename form', async () => {
      const projectId = seedProject('e2e-3200-rename-pinned');
      const sessionId = seedLiveSession(projectId);
      const base = `/api/v6/projects/${projectId}/sessions/${sessionId}/conversation/events`;
      await send('POST', base, { body: event(1, 'hello', 'user') });
      await send('POST', base, { body: event(2, 'hi there') });
      const { root, doc, settle } = mountShell(`#/resources/${projectId}/conversation`);
      await settle();
      const idSuffix = findMemberRenameIdSuffix(root, projectId);
      assert.equal(doc.getElementById('v6ChatJumpLatest').hidden, true, 'starts pinned');
      doc.getElementById(`v6TreeRename-${idSuffix}`).dispatch('click');
      assert.equal(doc.getElementById('v6ChatJumpLatest').hidden, true, 'opening the rename form must not unpin the stream');
      doc.getElementById(`v6TreeRenameCancel-${idSuffix}`).dispatch('click');
      assert.equal(doc.getElementById('v6ChatJumpLatest').hidden, true, 'canceling it must not unpin the stream either');
    });

    it('preserves #v6ChatStream\'s exact unpinned scrollTop across opening and canceling the sidebar rename form', async () => {
      const projectId = seedProject('e2e-3200-rename-unpinned');
      const sessionId = seedLiveSession(projectId);
      const base = `/api/v6/projects/${projectId}/sessions/${sessionId}/conversation/events`;
      await send('POST', base, { body: event(1, 'hello', 'user') });
      await send('POST', base, { body: event(2, 'hi there') });
      const { root, doc, settle } = mountShell(`#/resources/${projectId}/conversation`);
      await settle();
      const idSuffix = findMemberRenameIdSuffix(root, projectId);
      withStreamGeometry(doc.getElementById('v6ChatStream'), { scrollTop: 500, scrollHeight: 1000, clientHeight: 400 });
      doc.getElementById('v6ChatStream').dispatch('scroll');
      withStreamGeometry(doc.getElementById('v6ChatStream'), { scrollTop: 77, scrollHeight: 1000, clientHeight: 400 });
      doc.getElementById('v6ChatStream').dispatch('scroll');
      assert.equal(doc.getElementById('v6ChatJumpLatest').hidden, false, 'unpinned by the scroll above');
      doc.getElementById(`v6TreeRename-${idSuffix}`).dispatch('click');
      // render() replaces the stream element; re-query rather than reuse
      // the reference captured before the click, the same discipline
      // restoreViewState itself uses.
      assert.equal(doc.getElementById('v6ChatJumpLatest').hidden, false, 'opening the rename form must not silently re-pin it');
      assert.equal(doc.getElementById('v6ChatStream').scrollTop, 77, 'the exact reading position must survive the render, not snap back to 0 or to the bottom');
      doc.getElementById(`v6TreeRenameCancel-${idSuffix}`).dispatch('click');
      assert.equal(doc.getElementById('v6ChatStream').scrollTop, 77, 'canceling must not disturb it either');
    });

    // R3 (PRRA-R1-V658-W1C-PR3220-577120C7-REVISE item 1): the submit/save
    // path, not just open/cancel -- a real PATCH /api/projects/:name
    // against the real server (no stub: this file never mocks its API,
    // and apiMutate has no seam to stub through anyway), through the
    // per-MEMBER rename button -- options.onRenameProject ->
    // live.renameProject -> shell.renameResult -> closeSidebarRename ->
    // render(), the same render() cycle the open/cancel tests above
    // already rely on. Deliberately NOT the project-level button: with
    // this file's shared, cumulative test DB, many `e2e-*`-named projects
    // from OTHER tests can end up sharing a dash-prefix group, and that
    // button bulk-renames the whole group via renameFleetMembers --
    // the per-member button always targets exactly this one project.
    it('preserves #v6ChatStream\'s pin state and exact scrollTop across a real rename SUBMIT', async () => {
      const projectId = seedProject('e2e-3200-rename-submit');
      const sessionId = seedLiveSession(projectId);
      const base = `/api/v6/projects/${projectId}/sessions/${sessionId}/conversation/events`;
      await send('POST', base, { body: event(1, 'hello', 'user') });
      await send('POST', base, { body: event(2, 'hi there') });
      const { root, doc, settle } = mountShell(`#/resources/${projectId}/conversation`);
      await settle();
      const idSuffix = findMemberRenameIdSuffix(root, projectId);
      withStreamGeometry(doc.getElementById('v6ChatStream'), { scrollTop: 500, scrollHeight: 1000, clientHeight: 400 });
      doc.getElementById('v6ChatStream').dispatch('scroll');
      withStreamGeometry(doc.getElementById('v6ChatStream'), { scrollTop: 77, scrollHeight: 1000, clientHeight: 400 });
      doc.getElementById('v6ChatStream').dispatch('scroll');
      assert.equal(doc.getElementById('v6ChatJumpLatest').hidden, false, 'unpinned by the scroll above');
      // lib/projects.js refuses a rename outright ("Cannot rename while a
      // session is active") whenever store.sessions.getActive(project.id)
      // finds a row -- realistic: a real operator renames a project once
      // its session has ended, not mid-conversation. The conversation view
      // itself (and the pin/unpin exercised above) needs no ACTIVE session,
      // only the recorded events already posted, so ending the session here
      // -- after exercising the live view, before submitting the rename --
      // models that real sequence rather than fighting the business rule.
      store.getDb().prepare("UPDATE sessions SET status = 'ended' WHERE id = ?").run(sessionId);
      doc.getElementById(`v6TreeRename-${idSuffix}`).dispatch('click');
      const input = doc.getElementById(`v6TreeRenameInput-${idSuffix}`);
      assert.ok(input, 'the rename input must be mounted once the form is open');
      input.value = 'e2e-3200-rename-submit-NEW';
      input.dispatch('input');
      doc.getElementById(`v6TreeRenameForm-${idSuffix}`).dispatch('submit');
      await settle();
      // R4 (PRRA-R1-V658-W1C-PR3220-ADEC703B-REVISE): prove the rename
      // actually succeeded before trusting the pin/scrollTop assertions
      // below — the real id is `v6TreeRenameForm-${idSuffix}`, not the
      // bare `v6TreeRenameForm` the dispatch suggested (that id is never
      // rendered; every row's form is suffixed). The store, not just the
      // DOM, is the authoritative check: `refresh()` re-renders from
      // whatever the server now has, so a real PATCH success and a stale
      // render that merely closed the form read identically in the DOM
      // alone.
      assert.equal(
        store.getDb().prepare('SELECT name FROM projects WHERE id = ?').get(projectId).name,
        'e2e-3200-rename-submit-NEW',
        'the PATCH must have actually renamed the project in the store, not just closed the form'
      );
      // `root.innerHTML`, not `doc.getElementById` — this mini-DOM's
      // `byId` map (test/_mini-dom.js's withIdParsingInnerHTML) only ever
      // grows: an id once seen keeps answering with its (now stale) stub
      // forever, even once a later render's HTML no longer contains it.
      // Checking the live HTML text is the only way to prove "gone" here.
      assert.doesNotMatch(root.innerHTML, new RegExp(`id="v6TreeRenameForm-${idSuffix}"`), 'the rename form closes on a successful submit');
      assert.match(root.innerHTML, /e2e-3200-rename-submit-NEW/, 'the new name is visible in the re-rendered sidebar');
      assert.doesNotMatch(root.innerHTML, /id="v6TreeLink-m[0-9-]+"[^>]*>[^<]*e2e-3200-rename-submit</, 'the OLD name is gone from the sidebar, not just appended alongside the new one');
      assert.equal(doc.getElementById('v6ChatJumpLatest').hidden, false, 'a successful rename submit must not silently re-pin the stream');
      assert.equal(doc.getElementById('v6ChatStream').scrollTop, 77, 'and must not disturb the exact reading position either');
    });

    // R3 (PRRA-R1-V658-W1C-PR3220-577120C7-REVISE item 2): a REAL open<->
    // close state transition (hood.open mutated before each dispatch, not
    // a bare synthetic event with no state behind it), asserting the
    // listener that IS wired (rearmPeekPin, firing on every toggle
    // regardless of direction) actually re-arms #v6ChatPeek's own bottom
    // pin on each transition, while #v6ChatStream's own pin state and
    // exact scrollTop -- genuinely untouched by either of Under the
    // Hood's two toggle listeners (confirmed by reading both directly) --
    // survive both directions too. This exercises real, current, wired
    // behavior; it still cannot produce the real-browser RESIZE sibling
    // Car V658-W1-B's own ResizeObserver-driven re-pin reacts to (this
    // mini-DOM harness has no layout engine), which needs that car's own
    // test suite once merged.
    it('Under the Hood open<->close re-arms #v6ChatPeek\'s bottom pin on each transition, without disturbing #v6ChatStream', async () => {
      const projectId = seedProject('e2e-3200-uth-toggle');
      const sessionId = seedLiveSession(projectId);
      const base = `/api/v6/projects/${projectId}/sessions/${sessionId}/conversation/events`;
      await send('POST', base, { body: event(1, 'hello', 'user') });
      await send('POST', base, { body: event(2, 'hi there') });
      const { doc, settle } = mountShell(`#/resources/${projectId}/conversation`);
      await settle();
      const hood = doc.getElementById('v6ChatUnderHood');
      assert.ok(hood, 'Under the Hood must be mounted');

      // Unpin the stream with a specific reading position, so the toggle
      // transitions below have something real to preserve or disturb.
      withStreamGeometry(doc.getElementById('v6ChatStream'), { scrollTop: 500, scrollHeight: 1000, clientHeight: 400 });
      doc.getElementById('v6ChatStream').dispatch('scroll');
      withStreamGeometry(doc.getElementById('v6ChatStream'), { scrollTop: 77, scrollHeight: 1000, clientHeight: 400 });
      doc.getElementById('v6ChatStream').dispatch('scroll');
      assert.equal(doc.getElementById('v6ChatJumpLatest').hidden, false, 'stream unpinned by the scroll above');

      // Scroll the peek pane away from its own bottom too, so re-arming is
      // a real, visible state change rather than a no-op.
      const peek = doc.getElementById('v6ChatPeek');
      peek.scrollHeight = 900;
      peek.scrollTop = 200;

      hood.open = true;
      hood.dispatch('toggle'); // closed -> open
      assert.equal(peek.scrollTop, 900, 'opening re-arms #v6ChatPeek to its own bottom (rearmPeekPin) -- a real, wired effect');
      assert.equal(doc.getElementById('v6ChatJumpLatest').hidden, false, 'the stream itself is untouched by the open transition');
      assert.equal(doc.getElementById('v6ChatStream').scrollTop, 77, 'and its exact reading position survives it');

      peek.scrollTop = 300; // scroll peek away again before the other direction
      hood.open = false;
      hood.dispatch('toggle'); // open -> closed
      assert.equal(peek.scrollTop, 900, 'closing re-arms #v6ChatPeek to its own bottom too, the same listener firing either direction');
      assert.equal(doc.getElementById('v6ChatJumpLatest').hidden, false, 'the stream is still untouched by the close transition');
      assert.equal(doc.getElementById('v6ChatStream').scrollTop, 77, 'and its reading position still survives it');
    });
  });

  describe('Car V658-W1-C: stylesheet scroll-anchoring and overscroll containment contract (#3200)', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
    /** @param {string} selector @returns {string} the selector's own `{ ... }` body, or '' if not found. */
    const body = (selector) => {
      const m = new RegExp(`(^|\\n)${selector.replace(/[.[\]>="-]/g, '\\$&')} \\{([^}]*)\\}`).exec(css);
      return m ? m[2] : '';
    };

    it('declares overflow-anchor: auto and overscroll-behavior-y: contain on .v6-chat-stream, alongside its pre-existing flex/min-height invariants', () => {
      const rule = body('.v6-chat-stream');
      assert.match(rule, /overflow-anchor: auto;/);
      assert.match(rule, /overscroll-behavior-y: contain;/);
      assert.match(rule, /flex: 1 1 0%;/);
      assert.match(rule, /min-height: 120px;/);
      assert.match(rule, /max-height: none;/);
    });

    it('declares overscroll-behavior-y: contain on .v6-chat-peek, preserving its existing resize/overflow invariants', () => {
      const rule = body('.v6-chat-peek');
      assert.match(rule, /overscroll-behavior-y: contain;/);
      assert.match(rule, /resize: vertical;/);
      assert.match(rule, /overflow: auto;/);
      assert.match(rule, /min-height: 120px;/);
      assert.match(rule, /max-height: 70vh;/);
    });

    it('declares overscroll-behavior-y: contain on both .v6-chat-switchboard/.v6-chat-tucked and their own scrolling lists', () => {
      assert.match(body('.v6-chat-switchboard'), /overscroll-behavior-y: contain;/);
      assert.match(body('.v6-chat-switchboard-list'), /overscroll-behavior-y: contain;/);
      assert.match(body('.v6-chat-tucked'), /overscroll-behavior-y: contain;/);
      assert.match(body('.v6-chat-tucked-list'), /overscroll-behavior-y: contain;/);
    });

    it('gives each conversation turn (.v6-conversation-event) overflow-anchor: auto, supporting the stream\'s own scroll anchoring', () => {
      assert.match(body('.v6-conversation-event'), /overflow-anchor: auto;/);
    });

    it('preserves the sticky Under the Hood summary bar and the prior sprint\'s pane-resizer/traffic-toggle rules this sprint must not disturb', () => {
      assert.match(body('.v6-chat-under-hood > summary'), /position: sticky;\s*top: 0;/);
      assert.notEqual(css.indexOf('.v6-chat-pane-resizer'), -1);
      assert.notEqual(css.indexOf('.v6-chat-verbosity-option--traffic'), -1);
    });

    // R2 (PRRA-R1-V658-W1C-PR3220-4C2BB46F-REVISE BLOCKING 1): the drawer
    // itself (and the peek pane inside it) opts OUT of scroll-anchoring —
    // the opposite of .v6-chat-stream/.v6-conversation-event above, since
    // the drawer's own reflow is what could make the browser pick an
    // anchor inside it that then jumps the stream sibling.
    it('opts .v6-chat-under-hood (and .v6-chat-peek inside it) OUT of scroll-anchoring, and contains their own overscroll', () => {
      assert.match(body('.v6-chat-under-hood'), /overflow-anchor: none;/);
      assert.match(body('.v6-chat-under-hood[open]'), /overscroll-behavior: contain;/);
      assert.match(body('.v6-chat-peek'), /overflow-anchor: none;/);
    });

    it('.v6-chat-under-hood[open] still carries its pre-existing resize/floor/cap rules, unchanged by the new overscroll-behavior', () => {
      const rule = body('.v6-chat-under-hood[open]');
      assert.match(rule, /resize: vertical;/);
      assert.match(rule, /overflow: auto;/);
      assert.match(rule, /min-height: 80px;/);
      assert.match(rule, /max-height: 45vh;/);
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

  describe('Car V659-W1-C: offline Session Properties Save-Without-Starting (#3205)', () => {
    // #3205's actual sidebar Actions-menu/Session-Properties-editor markup
    // has no owning Builder car in the v659 sprint charter's Wave 1/2
    // tables (checked directly, not assumed) -- this is API-level
    // coverage of the Save-Without-Starting CONTRACT the issue describes
    // ("the project row updates in SQLite while store.sessions.getActive
    // remains null, and a subsequent launch uses the repaired
    // configuration"), which the existing PATCH /api/projects/:name route
    // already implements and needs no new sidebar UI to exercise.
    it('PATCH /api/projects/:name updates the store while the session stays stopped, never starting it', async () => {
      const projectId = seedProject('e2e-3205-save-without-starting');
      store.getDb().prepare(
        "INSERT INTO sessions (project_id, engine_id, status, session_mode, started_at) VALUES (?, 'claude', 'stopped', 'webui', datetime('now'))"
      ).run(projectId);
      assert.equal(store.sessions.getActive(projectId), null, 'no active session before the save, by construction');
      const res = await send('PATCH', `/api/projects/${encodeURIComponent('e2e-3205-save-without-starting')}`, { body: { name: 'e2e-3205-save-without-starting-fixed' } });
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(
        store.getDb().prepare('SELECT name FROM projects WHERE id = ?').get(projectId).name,
        'e2e-3205-save-without-starting-fixed',
        'the repaired configuration must be persisted'
      );
      assert.equal(store.sessions.getActive(projectId), null, 'saving offline configuration must never itself start a session');
    });

    it('a subsequent launch resolves against the repaired configuration, not the one the session was stuck on', async () => {
      const projectId = seedProject('e2e-3205-repair-then-launch');
      store.getDb().prepare(
        "INSERT INTO sessions (project_id, engine_id, status, session_mode, started_at) VALUES (?, 'claude', 'stopped', 'webui', datetime('now'))"
      ).run(projectId);
      // Repair BOTH the name and the engine in one save, so this proves more
      // than a rename survived — a broken engine choice is exactly the kind
      // of "misconfigured session" #3205 exists to let the operator fix
      // offline.
      const patchRes = await send('PATCH', `/api/projects/${encodeURIComponent('e2e-3205-repair-then-launch')}`, { body: { name: 'e2e-3205-repair-then-launch-fixed', engine: 'codex' } });
      assert.equal(patchRes.statusCode, 200, patchRes.body);
      const res = await send('GET', '/api/projects');
      const rows = json(res).projects || json(res);
      const row = (Array.isArray(rows) ? rows : []).find((p) => p.name === 'e2e-3205-repair-then-launch-fixed');
      assert.ok(row, 'the renamed/repaired project must be the one GET /api/projects now reports — nothing resolves the stale name anymore');
      assert.equal(row.engine.id, 'codex', 'the repaired engine must be the one GET /api/projects now reports too');
      // R2 (PRRB-R1-V659-W1C-PR3226-7E4624B5-REVISE BLOCKING 1): prove a
      // SUBSEQUENT LAUNCH would use the repaired config, not just that a
      // read API reports it. `lib/sessions.js#launchSession`'s own first
      // line is `store.projects.getByName(projectName)` -- calling that
      // exact resolution step directly (rather than the full POST
      // /api/sessions/:project route, which would go on to actually spawn
      // a real tmux/engine process this sandbox has neither configured nor
      // meant to exercise from a CSS/E2E car) is the proportionate way to
      // prove the launch path's own config resolution, without dragging in
      // the launch-stubbing harness (fake engine detection, a fake tmux
      // binary on PATH) that belongs to lib/sessions.js's own test
      // coverage, not this file's.
      const resolved = store.projects.getByName('e2e-3205-repair-then-launch-fixed');
      assert.ok(resolved, 'launchSession\'s own first resolution step must find the project under its new name');
      assert.equal(resolved.engineId, 'codex', 'and it must read the repaired engine, not the broken one the session was stuck on');
      assert.equal(store.projects.getByName('e2e-3205-repair-then-launch'), null, 'the stale old name must resolve to nothing, so a launch can never silently target it');
    });
  });

  /**
   * Car V659-W2-C, Issue #3203 (Ruling A927's own deferred mounted E2E):
   * the real public/v6-shell.js offline hero markup (PR #3227, merged) is
   * now live, so the hand-built FIXTURES above (Car V659-W1-C,
   * "mounted-DOM fixture coverage for the 4 offline/recovery states") are
   * superseded for these 3 scenarios by mounting the production code
   * itself — the whole point Ruling A927 deferred. The fixtures stay; they
   * covered a CSS/wiring contract while #3203's own markup had no owning
   * car yet, and that is still a true, useful statement about them.
   *
   * mountOfflineShell extends Car V659-W2-B's own mountShell() (this
   * file's top-level describe) with the 4 options #3203 needs that the
   * conversation/scroll-pin tests above never did — onStartSession,
   * onOpenProjectSettings, onViewOfflineHistory, onReturnToStartCard —
   * wired exactly as public/ui.js wires them (checked directly, not
   * assumed): `onStartSession(projectName) { v6Live.startSession(...) }`,
   * `onOpenProjectSettings(projectName) { openSettings(...) }`,
   * `onViewOfflineHistory`/`onReturnToStartCard` likewise. Settings is a
   * spy here, not a call into the real openSettings — see the #3214
   * describe below for why.
   */
  describe('Car V659-W2-C: Issue #3203 mounted offline hero, starting/failed launch transitions, and offline history (Ruling A927 deferred mounted E2E)', () => {
    /**
     * @param {string} initialHash
     * @returns {object}
     */
    function mountOfflineShell(initialHash) {
      const G = loadV6Shell();
      const { doc } = makeDocument([]);
      const root = doc.createElement('div');
      withIdParsingInnerHTML(root, doc);
      doc.body.appendChild(root);
      const win = makeFakeWindow(initialHash);
      const { api, apiMutate, calls } = liveApi();
      const pending = [];
      let shell = null;
      const readFileAsBase64 = async (file) => Buffer.from(file.content).toString('base64');
      const openedSettingsFor = [];
      const live = G.tcV6CreateLiveController({ getShell: () => shell, api, apiMutate, operatorHeaders: async () => ({}), readFileAsBase64, storage: null });
      shell = G.tcCreateV6Shell(doc, {
        root, window: win,
        onLaunchTemplate: (id) => pending.push(live.launchTemplate(id)),
        onRender: (route) => pending.push(live.handleRoute(route)),
        onSendChat: (text) => pending.push(live.sendChat(text)),
        onChangeDelegate: (nodeId, projectId) => pending.push(live.changeDelegate(nodeId, projectId)),
        onRefreshChat: () => pending.push(live.refresh()),
        onAttachFiles: (files) => pending.push(live.attachFiles(files)),
        onRemoveAttachment: (i) => pending.push(live.removeAttachment(i)),
        onRenameProject: (oldName, newName, opts) => pending.push(live.renameProject(oldName, newName, opts)),
        onStartSession: (name) => { pending.push(live.startSession(name)); },
        onOpenProjectSettings: (name) => { openedSettingsFor.push(name); },
        onViewOfflineHistory: (name) => { pending.push(live.viewOfflineHistory(name)); },
        onReturnToStartCard: (name) => live.returnToStartCard(name),
        storage: null
      });
      pending.push(live.handleRoute(shell.getRoute()));
      const settle = async () => { while (pending.length) await pending.shift(); };
      return { G, shell, root, win, live, calls, settle, doc, openedSettingsFor };
    }

    it('a project with no active session renders the real offline hero — Start, View History and Edit Properties, no diagnostic yet', async () => {
      const projectId = seedProject('e2e-3203-hero');
      const { root, settle } = mountOfflineShell(`#/resources/${projectId}/conversation`);
      await settle();
      assert.match(root.innerHTML, /class="v6-chat-offline-hero" role="status"/);
      assert.match(root.innerHTML, /id="v6ChatStartHero"/);
      assert.match(root.innerHTML, /id="v6ChatViewHistoryHero"/);
      assert.match(root.innerHTML, /id="v6ChatEditPropertiesHero"/);
      assert.doesNotMatch(root.innerHTML, /v6-chat-offline-hero-diagnostic/, 'no failure yet, so no diagnostic box');
    });

    it('clicking Start transitions the hero through "starting" synchronously, then to "failed" with Retry once a real launch is refused', async () => {
      const projectId = seedProject('e2e-3203-starting-failed');
      // Deliberately unresolvable engine: launchSession's own engine-
      // resolution check (lib/sessions.js) fails this FAST and
      // synchronously (verified directly: ~2ms, no tmux/process spawn),
      // before ever reaching the parts of the launch path this sandbox
      // has no real engine binary or tmux session for — the same
      // proportionality V659-W1-C's own test above already explains.
      store.getDb().prepare('UPDATE projects SET engine_id = ? WHERE id = ?').run('does-not-exist-engine', projectId);
      const { doc, root, settle } = mountOfflineShell(`#/resources/${projectId}/conversation`);
      await settle();
      doc.getElementById('v6ChatStartHero').dispatch('click');
      // startSession's own synchronous prefix — launchState.set('starting')
      // then showChat()/render() — runs before its first `await
      // apiMutate(...)` yields control, so "starting" must already be on
      // screen here, before settle() lets the launch call resolve.
      assert.match(root.innerHTML, /class="v6-chat-offline-hero is-starting"/, 'is-starting must be on the OUTER hero (the CSS spinner selector targets it there), synchronously');
      assert.match(root.innerHTML, /id="v6ChatStartHero"[^>]*disabled/, 'Start must disable itself while already starting, not stay re-clickable');
      await settle();
      assert.match(root.innerHTML, /v6-chat-offline-hero-pill is-failed">Launch Failed/, 'the unresolvable engine must fail the REAL launch route, not silently succeed');
      assert.match(root.innerHTML, /v6-chat-offline-hero-diagnostic-message">Not started: Engine &quot;does-not-exist-engine&quot; not found/, 'the server\'s real refusal reason must reach the diagnostic box');
      assert.match(root.innerHTML, /id="v6ChatRetryLaunchHero"/, 'Retry Launch must be offered after a failed attempt');
    });

    it('View Previous Conversation loads the project\'s real persisted B2 events (history -> conversation/events), and Return to Start Card restores the hero', async () => {
      const projectId = seedProject('e2e-3203-history');
      // An ENDED session, not an active one — #3203's own viewOfflineHistory
      // doc comment (public/v6-shell.js) is explicit that GET .../history
      // names the most recent session row "regardless of status".
      const sessionId = store.getDb().prepare(
        "INSERT INTO sessions (project_id, engine_id, status, session_mode, started_at, ended_at) VALUES (?, 'claude', 'ended', 'webui', datetime('now'), datetime('now'))"
      ).run(projectId).lastInsertRowid;
      await send('POST', `/api/v6/projects/${projectId}/sessions/${sessionId}/conversation/events`, {
        body: { launchId: 'l1', seq: 1, tier: 'A', adapter: 'claude', role: 'user', content: 'what happened while I was away?' }
      });
      const { doc, root, settle } = mountOfflineShell(`#/resources/${projectId}/conversation`);
      await settle();
      doc.getElementById('v6ChatViewHistoryHero').dispatch('click');
      await settle();
      assert.match(root.innerHTML, /class="v6-chat-offline-history" aria-label/);
      assert.match(root.innerHTML, /what happened while I was away\?/, 'the REAL persisted event, fetched via the real history + conversation/events routes, must actually render');
      assert.ok(doc.getElementById('v6ChatOfflineHistoryReturnTop'), 'the Return to Start Card control must be present');
      doc.getElementById('v6ChatOfflineHistoryReturnTop').dispatch('click');
      await settle();
      assert.match(root.innerHTML, /class="v6-chat-offline-hero" role="status"/, 'Return to Start Card must restore the hero, in place');
    });
  });

  /**
   * Car V659-W2-C, Issue #3214: `openSettings` (public/ui.js) has too many
   * top-level dependencies (state, esc, apiMutate, DOM) to invoke directly
   * — the SAME documented constraint test/settings-modal-silentprime.test.js
   * and test/engine-model-picker.test.js already work around with
   * source-level liftBody()/liftDeclaration() assertions, the latter
   * already covering #settingsEngineCards' 4 engines, #settingsModelSelect
   * and #settingsEffortSelect + #settingsPathHealthBadge in detail
   * (#3214 R-Gate R1/R5/R6 describes in that file). Neither file is in
   * this car's envelope to extend further, and re-deriving that coverage
   * here would duplicate it, not add to it.
   *
   * What a MOUNTED shell genuinely can prove, and does here, is the half
   * of the integration that belongs to it: that the real v6ChatSettings
   * control calls options.onOpenProjectSettings with the correct project
   * name — the exact call public/ui.js wires to `openSettings(projectName)`
   * (`onOpenProjectSettings(projectName) { openSettings(projectName); }`,
   * checked directly). This is the shell's own reachability contract, not
   * a stand-in for testing openSettings' render.
   */
  describe('Car V659-W2-C: Issue #3214 mounted shell reaches Settings with the correct project name', () => {
    it('the chat header\'s Settings control calls onOpenProjectSettings with THIS chat\'s own project name', async () => {
      const projectId = seedProject('e2e-3214-settings-reachability');
      const G = loadV6Shell();
      const { doc } = makeDocument([]);
      const root = doc.createElement('div');
      withIdParsingInnerHTML(root, doc);
      doc.body.appendChild(root);
      const win = makeFakeWindow(`#/resources/${projectId}/conversation`);
      const { api, apiMutate } = liveApi();
      const pending = [];
      let shell = null;
      const openedSettingsFor = [];
      const live = G.tcV6CreateLiveController({ getShell: () => shell, api, apiMutate, operatorHeaders: async () => ({}), readFileAsBase64: async () => '', storage: null });
      shell = G.tcCreateV6Shell(doc, {
        root, window: win,
        onRender: (route) => pending.push(live.handleRoute(route)),
        onOpenProjectSettings: (name) => { openedSettingsFor.push(name); },
        storage: null
      });
      pending.push(live.handleRoute(shell.getRoute()));
      while (pending.length) await pending.shift();
      const settingsBtn = doc.getElementById('v6ChatSettings');
      assert.ok(settingsBtn, 'the header\'s Settings control must be mounted, offline session or not');
      settingsBtn.dispatch('click');
      assert.deepEqual(openedSettingsFor, ['e2e-3214-settings-reachability'], 'must reach onOpenProjectSettings with exactly this chat\'s own project name');
    });
  });

  /**
   * Car V659-W2-C, Issue #3218: `tcBindMasterDropzone`/
   * `tcSanitizeMasterAttachmentFilename` (public/api-helper.js, PR #3229,
   * merged) are already exhaustively unit-tested in isolation
   * (test/master-control-bar.test.js) against a SYNTHETIC panel/frame
   * pair. What that suite cannot prove, and this does, is that the ids
   * `tcBindMasterDropzone`'s own fallback resolution hardcodes
   * (`"masterPanel"` -> `"masterFrame"`) and the nesting its positioning
   * fix (#3218 R3) depends on both match the REAL public/index.html
   * markup — read directly below, not assumed.
   *
   * Note (#3218 Wave 2 dependency, checked directly): `tcBindMasterDropzone`
   * is not yet CALLED from any production page script — grepped
   * public/ui.js, public/session.js and public/v6-shell.js, no call site
   * exists. Wiring it up is Car V659-W2-D's own deliverable, once this
   * car's sibling PRs land. So "mounted" here means against the real
   * index.html markup and real api-helper.js globals, which is everything
   * actually live right now — not a page that calls it yet, which does
   * not exist to mount against.
   */
  describe('Car V659-W2-C: Issue #3218 tcBindMasterDropzone against the real index.html markup and nesting', () => {
    it('public/index.html\'s #masterPanel/#masterFrame markup matches tcBindMasterDropzone\'s own fallback id resolution and nesting assumptions', () => {
      const htmlSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
      assert.match(htmlSrc, /<div id="masterPanel" class="master-panel"/, '#masterPanel must exist with this exact id — tcBindMasterDropzone\'s default prefix is "masterPanel"');
      assert.match(htmlSrc, /<iframe id="masterFrame"/, 'the fallback frame lookup for the "masterPanel" prefix is literally "masterFrame" (public/api-helper.js)');
      const panelIdx = htmlSrc.indexOf('<div id="masterPanel"');
      const frameIdx = htmlSrc.indexOf('id="masterFrame"', panelIdx);
      const wrapIdx = htmlSrc.lastIndexOf('<div class="master-frame-wrap">', frameIdx);
      assert.ok(wrapIdx > panelIdx && wrapIdx < frameIdx,
        '#masterFrame must sit inside a .master-frame-wrap, nested one level below #masterPanel — this is exactly the "frame\'s real parent is not panelEl" shape the mounted test below exercises');
    });

    /**
     * The exact `<div id="masterPanel" ...> ... </div>` fragment of
     * `html`, depth-matched rather than a fixed-size window or the next
     * literal `</div>` — this repo's own `liftBody`/`liftDeclaration`
     * (test/helpers/lift.js) do the same for a JS function's braces;
     * this is that technique for an HTML element's own nested divs.
     * @param {string} html
     * @returns {string}
     */
    function extractMasterPanelBlock(html) {
      const openTag = /<div[^>]*\bid="masterPanel"[^>]*>/.exec(html);
      assert.ok(openTag, '#masterPanel must exist');
      let depth = 1;
      const tagRe = /<div\b[^>]*>|<\/div>/g;
      tagRe.lastIndex = openTag.index + openTag[0].length;
      let tag;
      while (depth > 0 && (tag = tagRe.exec(html))) {
        depth += tag[0].startsWith('</') ? -1 : 1;
      }
      return html.slice(openTag.index, tagRe.lastIndex);
    }

    /**
     * A minimal tag-stack HTML -> mini-DOM builder, bounded to exactly the
     * shapes `public/index.html`'s own `#masterPanel` block uses (nested
     * elements, every one explicitly closed, no scripts/styles) — not a
     * general HTML parser. Comments are stripped first; only `id`/`class`
     * attributes are read, which is all `tcBindMasterDropzone` itself
     * reads off these elements (per `withIdParsingInnerHTML`'s own
     * limitation, learned the hard way earlier this car: it builds FLAT
     * id stand-ins, never real nesting, so it cannot stand in here).
     * @param {object} doc
     * @param {string} html
     * @returns {object} The root element.
     */
    function buildTreeFromRealHtml(doc, html) {
      const clean = html.replace(/<!--[\s\S]*?-->/g, '');
      const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
      const stack = [];
      let root = null;
      let match;
      while ((match = tagRe.exec(clean))) {
        const [, closing, tag, attrs] = match;
        if (closing) { stack.pop(); continue; }
        const el = doc.createElement(tag);
        el.style = {};
        const idMatch = /\bid="([^"]*)"/.exec(attrs);
        const classMatch = /\bclass="([^"]*)"/.exec(attrs);
        if (idMatch) { el.id = idMatch[1]; doc._register(el); }
        if (classMatch) el.className = classMatch[1];
        if (stack.length) stack[stack.length - 1].appendChild(el);
        else root = el;
        stack.push(el);
      }
      return root;
    }

    it('mounted against the REAL #masterPanel markup (parsed from public/index.html, not a hand-built tree), it positions both unpositioned ancestors, survives a real bubbling drop delivering the file exactly once, and restores the frame\'s pointer-events', () => {
      const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
      const block = extractMasterPanelBlock(indexHtml);
      const { doc } = makeDocument([]);
      /** Captures every listener a target registers, by type. */
      function captureAddEventListener(target) {
        const handlers = {};
        const real = typeof target.addEventListener === 'function' ? target.addEventListener.bind(target) : null;
        target.addEventListener = (type, fn) => {
          (handlers[type] = handlers[type] || []).push(fn);
          if (real) real(type, fn);
        };
        return handlers;
      }
      const docHandlers = captureAddEventListener(doc);
      // Build the real tree FIRST, consuming the createElement calls that
      // parsing it needs, THEN wrap createElement to capture the NEXT one
      // — the dropzone overlay tcBindMasterDropzone itself creates. Doing
      // this in the other order would wrongly capture #masterPanel (the
      // tree's own first element) as "the overlay" instead.
      const panelEl = buildTreeFromRealHtml(doc, block);
      assert.equal(panelEl.id, 'masterPanel', 'the parsed root must be the real #masterPanel element');
      const panelHandlers = captureAddEventListener(panelEl);
      const frameEl = doc.getElementById('masterFrame');
      assert.ok(frameEl, '#masterFrame must have parsed out of the real markup');

      let overlay = null;
      let overlayHandlers = null;
      const realCreateElement = doc.createElement.bind(doc);
      doc.createElement = (tag) => {
        const el = realCreateElement(tag);
        if (!overlayHandlers) { overlay = el; overlayHandlers = captureAddEventListener(el); }
        return el;
      };

      const G = loadApiHelperGlobals();
      G.Blob = Blob;
      G.File = File;
      const delivered = [];
      G.tcBindMasterDropzone({ doc, panelEl, prefix: 'masterPanel', onUpload: (f, sanitized) => delivered.push(sanitized) });

      assert.equal(panelEl.style.position, 'relative', '#masterPanel has no position rule in public/style.css — it must get one, as the overlay\'s own containing block');
      assert.equal(doc.getElementById('masterPanelBar').parentNode, panelEl, 'sanity: the real nesting parsed correctly — .master-status-row is a direct child of #masterPanel');
      const frameWrap = frameEl.parentNode;
      assert.equal(frameWrap.className, 'master-frame-wrap', '#masterFrame\'s real parent, parsed from the real markup, is .master-frame-wrap — not #masterPanel directly');
      assert.equal(frameWrap.style.position, 'relative', '.master-frame-wrap has no position rule either, and it — not #masterPanel — is #masterFrame\'s REAL parent');
      assert.ok(overlay, 'the overlay must have been created');
      assert.equal(overlay.parentNode, panelEl, 'the overlay must mount as a direct child of #masterPanel, matching where tcBindMasterDropzone appends it');

      docHandlers.dragenter[0]({ dataTransfer: { types: ['Files'] } });
      assert.equal(overlay.classList.contains('hidden'), false, 'revealed on a file drag over the real page');
      assert.equal(frameEl.style.pointerEvents, 'none', 'the real #masterFrame iframe must stop intercepting pointer input while the drag is live');

      // A real drop fires at the overlay (the actual target under the
      // cursor) and then bubbles to the panel's own drop listener — the
      // SAME event object reaching both, exactly as a real browser
      // bubble would. Must deliver the one dropped file exactly once.
      const fileA = { name: 'Screenshot 2026-11-23 at 8.00.00 AM.png' };
      const evt = { preventDefault: () => {}, dataTransfer: { files: [fileA] } };
      overlayHandlers.drop[0](evt);
      panelHandlers.drop[0](evt);
      assert.deepEqual(delivered, ['Screenshot-2026-11-23-at-8.00.00-AM.png'], 'exactly one delivery, sanitized, even though the real bubble reaches both drop listeners');
      assert.equal(frameEl.style.pointerEvents, '', 'restored once the drop is handled, not left stuck at none');
    });
  });
});

describe('Car V656-W1-B: sticky Under the Hood toggle bar and two-way pane resizer styling (#3187)', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  /** @param {string} selector @returns {string} the selector's own `{ ... }` body, or '' if not found. */
  const body = (selector) => {
    const m = new RegExp(`(^|\\n)${selector.replace(/[.[\]>="-]/g, '\\$&')} \\{([^}]*)\\}`).exec(css);
    return m ? m[2] : '';
  };

  it('pins the Under the Hood <summary> toggle bar to the top of its own scroll container', () => {
    assert.match(body('.v6-chat-under-hood > summary'), /position: sticky;\s*top: 0;/);
    assert.match(body('.v6-chat-under-hood > summary'), /z-index: 5;/);
    assert.match(body('.v6-chat-under-hood > summary'), /background: var\(--v6-surface, #0d0d0d\);/,
      'an opaque fill behind the sticky bar — without it, content scrolling underneath would show through');
  });

  it('still carries the toggle bar\'s own pre-existing cursor and spacing, unchanged by the sticky styling', () => {
    assert.match(body('.v6-chat-under-hood > summary'), /cursor: pointer;/);
    assert.match(body('.v6-chat-under-hood > summary'), /margin-bottom: 6px;/);
  });

  it('gives the two-way pane resizer bar a draggable cursor and the touch/selection behavior a drag handle needs', () => {
    assert.match(body('.v6-chat-pane-resizer'), /cursor: ns-resize;/);
    assert.match(body('.v6-chat-pane-resizer'), /user-select: none;/);
    assert.match(body('.v6-chat-pane-resizer'), /touch-action: none;/);
    assert.match(body('.v6-chat-pane-resizer'), /display: flex;/);
  });

  it('gives the resizer\'s left/center/right grips their own distinct corner/pill sizes', () => {
    assert.match(body('.v6-chat-pane-resizer-grip'), /height: 4px;/);
    assert.match(body('.v6-chat-pane-resizer-grip'), /border-radius: 999px;/);
    assert.match(css, /\.v6-chat-pane-resizer-grip--left,\s*\.v6-chat-pane-resizer-grip--right \{\s*width: 14px;\s*\}/,
      'the corner grips share one narrower width');
    assert.match(body('.v6-chat-pane-resizer-grip--center'), /width: 36px;/, 'the center grip is the wider pill');
  });

  it('lights the grips venom-green on hover, keyboard focus, and drag — not just one of the three', () => {
    assert.match(css,
      /\.v6-chat-pane-resizer:hover \.v6-chat-pane-resizer-grip,\s*\.v6-chat-pane-resizer:focus-visible \.v6-chat-pane-resizer-grip,\s*\.v6-chat-pane-resizer:active \.v6-chat-pane-resizer-grip \{\s*background: var\(--tc-venom-green, #9CF732\);\s*\}/);
  });

  it('declares both the --top and --bottom edge variants, for the resizer\'s own two placements relative to its neighboring pane', () => {
    assert.notEqual(css.indexOf('.v6-chat-pane-resizer--top'), -1);
    assert.notEqual(css.indexOf('.v6-chat-pane-resizer--bottom'), -1);
  });

  it('preserves the pre-existing stream/peek/input/under-hood rules this sprint must not disturb', () => {
    assert.match(body('.v6-chat-stream'), /flex: 1 1 0%;\s*min-height: 120px;\s*max-height: none;/);
    assert.match(body('.v6-chat-peek'), /min-height: 120px;[\s\S]*max-height: 70vh;[\s\S]*resize: vertical;/);
    assert.match(body('.v6-chat-input'), /border: 2px solid var\(--v6-outline, #3d444d\);/);
    assert.match(body('.v6-chat-under-hood'), /border: 1\.5px solid var\(--v6-outline, #3d444d\);/);
    assert.match(body('.v6-chat-under-hood'), /background: var\(--v6-surface, #0d0d0d\);/);
  });
});

describe('Car V657-W1-B: "Hide Medusa & fleet chatter" toggle styling and hidden-traffic layout (#3192)', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  /** @param {string} selector @returns {string} the selector's own `{ ... }` body, or '' if not found. */
  const body = (selector) => {
    const m = new RegExp(`(^|\\n)${selector.replace(/[.[\]>="-]/g, '\\$&')} \\{([^}]*)\\}`).exec(css);
    return m ? m[2] : '';
  };

  it('sets the "Hide Medusa & fleet chatter" option visually apart from the other verbosity checkboxes, not just one more item in the list', () => {
    const rule = body('.v6-chat-verbosity-option--traffic');
    assert.notEqual(rule, '', '.v6-chat-verbosity-option--traffic must be declared');
    assert.match(rule, /border-radius: 999px;/, 'a pill, matching the "pill highlight" the dispatch asked for');
    assert.match(rule, /border-left: 1px solid var\(--v6-outline, #3d444d\);/, 'a divider line separating it from the reply-kind checkboxes');
    assert.match(rule, /background: rgba\(156, 247, 50, 0\.08\);/, 'a brand-accent tint, distinguishing it from the plain checkboxes');
  });

  it('suppresses .v6-chat-tucked/.v6-chat-switchboard/.v6-chat-tucked-count entirely when Under the Hood carries is-traffic-hidden', () => {
    assert.match(css,
      /\.v6-chat-under-hood\.is-traffic-hidden \.v6-chat-tucked,\s*\.v6-chat-under-hood\.is-traffic-hidden \.v6-chat-switchboard,\s*\.v6-chat-under-hood\.is-traffic-hidden \.v6-chat-tucked-count,\s*\.v6-chat-tucked\[hidden\],\s*\.v6-chat-switchboard\[hidden\] \{\s*display: none !important;\s*\}/,
      'all five selectors must share one display:none!important rule, exactly as dispatched');
  });

  it('also catches the plain [hidden] attribute form directly, not only the is-traffic-hidden class on the drawer', () => {
    // The two forms are independent triggers for the same zero-space rule:
    // is-traffic-hidden is set on #v6ChatUnderHood by the default-checked
    // toggle, while [hidden] is the attribute each section itself carries
    // either way — a future caller that sets one without the other (or a
    // browser applying its own UA default against a competing flex/block
    // rule) must still get display:none, not a layout-breaking gap.
    assert.match(css, /\.v6-chat-tucked\[hidden\][\s\S]{0,400}display: none !important;/);
    assert.match(css, /\.v6-chat-switchboard\[hidden\][\s\S]{0,400}display: none !important;/);
  });

  it('never weakens the suppression to a plain display: none that a later, more specific flex/block rule could override', () => {
    // The dispatch's whole point ("cleanly suppresses layout display
    // regardless of flex/block display rules") is the !important; a
    // regression here would silently let .v6-chat-tucked/.v6-chat-switchboard
    // reserve space again once hidden.
    const ruleStart = css.indexOf('.v6-chat-under-hood.is-traffic-hidden .v6-chat-tucked,');
    assert.notEqual(ruleStart, -1);
    const ruleBody = css.slice(ruleStart, css.indexOf('}', ruleStart) + 1);
    assert.match(ruleBody, /display: none !important;/);
  });

  it('leaves the pre-existing .v6-chat-tucked/.v6-chat-switchboard margin rules intact — this only adds a [hidden]/is-traffic-hidden override, not a replacement', () => {
    assert.match(body('.v6-chat-tucked'), /margin-bottom: 6px;/);
    assert.match(body('.v6-chat-switchboard'), /margin-bottom: 6px;/);
  });

  it('still carries the sticky Under the Hood summary toggle bar this sprint must not disturb (#3187)', () => {
    assert.match(body('.v6-chat-under-hood > summary'), /position: sticky;\s*top: 0;/);
  });
});

describe('Car V659-W1-C: offline startup hero and sidebar session-actions/status-pill styling (#3203, #3205)', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  /** @param {string} selector @returns {string} the selector's own `{ ... }` body, or '' if not found. */
  const body = (selector) => {
    const m = new RegExp(`(^|\\n)${selector.replace(/[.[\]>="-]/g, '\\$&')} \\{([^}]*)\\}`).exec(css);
    return m ? m[2] : '';
  };

  it('centers the offline hero card inside the chat workspace with a clear visual hierarchy', () => {
    assert.match(body('.v6-chat-offline-hero'), /display: flex;/);
    assert.match(body('.v6-chat-offline-hero'), /align-items: center;/);
    assert.match(body('.v6-chat-offline-hero'), /justify-content: center;/);
    assert.match(body('.v6-chat-offline-hero-card'), /border: 1\.5px solid var\(--v6-outline, #3d444d\);/);
    assert.match(body('.v6-chat-offline-hero-title'), /font-weight: 600;/);
    assert.match(body('.v6-chat-offline-hero-subtitle'), /opacity: 0\.8;/);
    assert.match(body('.v6-chat-offline-hero-actions'), /display: flex;/);
  });

  it('animates the "Starting session..." transition, with prefers-reduced-motion support', () => {
    assert.match(css, /\.v6-chat-offline-hero\.is-starting \.v6-chat-offline-hero-title::after \{[^}]*animation: v6-offline-hero-spin 0\.8s linear infinite;/);
    assert.match(css, /@keyframes v6-offline-hero-spin \{\s*to \{ transform: rotate\(360deg\); \}\s*\}/);
    assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\.v6-chat-offline-hero\.is-starting \.v6-chat-offline-hero-title::after \{\s*animation: none;/);
  });

  it('gives a failed launch a structured, readable diagnostic box', () => {
    const rule = body('.v6-chat-offline-hero-diagnostic');
    assert.match(rule, /border: 1px solid #f85149;/);
    assert.match(rule, /color: #f85149;/);
    assert.match(rule, /overflow-wrap: anywhere;/, 'a long diagnostic message must wrap rather than overflow');
  });

  /**
   * WCAG relative luminance of an `#rrggbb` colour — the same algorithm
   * test/theme-contrast.test.js's own `luminance()` uses, duplicated here
   * rather than imported since that file exports nothing.
   * @param {string} hex
   * @returns {number}
   */
  function luminance(hex) {
    const h = hex.replace('#', '');
    const channels = (h.match(/../g) || []).map((pair) => {
      const v = parseInt(pair, 16) / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  }

  /** WCAG contrast ratio between two `#rrggbb` colours. */
  function contrastRatio(a, b) {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  }

  it('R2 (BLOCKING 2): the light-theme diagnostic text clears WCAG AA 4.5:1 against its own composited background', () => {
    // [data-theme="light"] .v6-chat-offline-hero-diagnostic sits on
    // .v6-chat-offline-hero-card's background (--v6-surface, #FFFFFF in
    // the light theme) tinted by its own `background: rgba(248, 81, 73,
    // 0.08)` -- composited by hand here (alpha-blend over the card's
    // white) since this mini-DOM has no real rendering to read a computed
    // background from. #fef1f0 is that composite, confirmed against the
    // exact rgba() this file's own light-theme rule declares.
    const lightRule = css.slice(css.indexOf('[data-theme="light"] .v6-chat-offline-hero-diagnostic'));
    const bgMatch = /background: rgba\((\d+), (\d+), (\d+), ([\d.]+)\)/.exec(lightRule);
    const colorMatch = /\n\s*color: (#[0-9a-fA-F]{6});/.exec(lightRule);
    assert.ok(bgMatch && colorMatch, 'both the tinted background and the overriding text color must be declared together');
    const [, r, g, b, alpha] = bgMatch;
    const a = Number(alpha);
    const composite = (fg, bgChannel) => Math.round(bgChannel * (1 - a) + fg * a);
    const compositedBg = [composite(Number(r), 255), composite(Number(g), 255), composite(Number(b), 255)]
      .map((n) => n.toString(16).padStart(2, '0')).join('');
    assert.equal(`#${compositedBg}`, '#fef1f0', 'sanity check: the composite must match the ratio this fix was computed against');
    const ratio = contrastRatio(colorMatch[1], `#${compositedBg}`);
    assert.ok(ratio >= 4.5, `expected >= 4.5:1, got ${ratio.toFixed(2)}:1 for ${colorMatch[1]} on #${compositedBg}`);
  });

  it('gives the offline conversation history viewer its own visually separated bar', () => {
    assert.match(body('.v6-chat-offline-history-bar'), /border-top: 1px dashed var\(--v6-outline, #3d444d\);/);
  });

  it('gives every sidebar session row a consistent actions row with accessible hover/focus states', () => {
    assert.match(body('.v6-tree-member-actions'), /display: inline-flex;/);
    const btn = body('.v6-tree-action-btn');
    assert.match(btn, /cursor: pointer;/);
    assert.match(css, /\.v6-tree-action-btn:hover,\s*\.v6-tree-action-btn:focus-visible \{\s*opacity: 1;/, 'hover and focus-visible share the same highlighted state');
  });

  it('styles starting/failed/offline status pills with the sidebar\'s own existing state colors, not new ones', () => {
    // Plain substring matches, not body() -- `.v6-status-pill--offline` is
    // also the LAST selector in the shared base rule just above these three
    // standalone ones (`...--starting,\n...--failed,\n...--offline {`), and
    // body()'s own regex matches whichever occurrence is immediately
    // followed by ` {` first; only the last item in that comma list looks
    // like a standalone rule to it.
    assert.match(css, /\.v6-status-pill--starting \{ color: #d4a72c; \}/, 'the same amber .v6-shell-member-link.is-starting already uses');
    assert.match(css, /\.v6-status-pill--failed \{ color: #f85149; \}/, 'the same red .v6-member-ai-status.is-outage already uses');
    assert.match(css, /\.v6-status-pill--offline \{ color: inherit; opacity: 0\.6; \}/, 'the same dimming .v6-shell-member-link.is-offline already uses');
  });

  it('preserves the pre-existing sidebar member/status rules this sprint must not disturb', () => {
    assert.match(body('.v6-shell-member-link.is-starting,\n.v6-shell-member-link.is-wrapping'), /color: #d4a72c;/);
    assert.match(body('.v6-member-ai-status.is-outage'), /border-color: #f85149;\s*color: #f85149;/);
  });
});

/**
 * R2 (PRRB-R1-V659-W1C-PR3226-7E4624B5-REVISE BLOCKING 1): mounted-DOM
 * fixture coverage for the 4 required states. These are NOT public/v6-
 * shell.js's own markup — no Builder car owns that this sprint (Car
 * V659-W2-B lands #3205's real sidebar markup once Car V659-W1-B
 * merges, per the PM's own R1 reply) — they are hand-built fixtures
 * using the exact class vocabulary #3203/#3205 specify, so this file
 * can verify the CSS classes apply correctly, each state's own
 * structure is distinct, and the interaction wiring the real markup
 * will need (click -> callback) is at least coherent against that
 * vocabulary. This is a contract/fixture test, not a test of real
 * production code; it is marked as such throughout rather than implied
 * to be more.
 */
describe('Car V659-W1-C: mounted-DOM fixture coverage for the 4 offline/recovery states (#3203, #3205)', () => {
  /** A minimal mounted `doc`/`root` this file's other describes already use, with no live server involved — pure DOM fixture mounting. */
  function mountFixture(html) {
    const { doc } = makeDocument([]);
    const root = doc.createElement('div');
    withIdParsingInnerHTML(root, doc);
    doc.body.appendChild(root);
    root.innerHTML = html;
    return { doc, root };
  }

  it('fixture: stopped — the hero card shows Start/View History/Edit Properties, no spinner or diagnostic', () => {
    const { doc, root } = mountFixture(`
      <div id="v6ChatOfflineHero" class="v6-chat-offline-hero">
        <div class="v6-chat-offline-hero-card">
          <h3 id="v6OfflineHeroTitle" class="v6-chat-offline-hero-title">Session offline</h3>
          <p class="v6-chat-offline-hero-subtitle">Start it to resume the conversation.</p>
          <div class="v6-chat-offline-hero-actions">
            <button type="button" id="v6OfflineStart" class="btn btn-primary">▶ Start Session</button>
            <button type="button" id="v6OfflineHistory" class="btn btn-secondary">🕓 View Previous Conversation</button>
            <button type="button" id="v6OfflineEditProps" class="btn btn-secondary">⚙ Edit Session Properties</button>
          </div>
        </div>
      </div>`);
    assert.doesNotMatch(root.innerHTML, /is-starting/, 'stopped is not starting');
    assert.doesNotMatch(root.innerHTML, /v6-chat-offline-hero-diagnostic/, 'stopped has no failure diagnostic');
    let started = false;
    doc.getElementById('v6OfflineStart').addEventListener('click', () => { started = true; });
    doc.getElementById('v6OfflineStart').dispatch('click');
    assert.equal(started, true, 'the Start Session action must be wireable to a click');
  });

  it('fixture: starting — the hero card carries is-starting on the title for the animated spinner, actions disabled', () => {
    const { doc, root } = mountFixture(`
      <div id="v6ChatOfflineHero" class="v6-chat-offline-hero is-starting">
        <div class="v6-chat-offline-hero-card">
          <h3 id="v6OfflineHeroTitle" class="v6-chat-offline-hero-title">Starting session…</h3>
          <div class="v6-chat-offline-hero-actions">
            <button type="button" id="v6OfflineStart" class="btn btn-primary" disabled>▶ Start Session</button>
          </div>
        </div>
      </div>`);
    assert.match(root.innerHTML, /class="v6-chat-offline-hero is-starting"/, 'is-starting must be on the outer hero, where the CSS spinner selector targets it');
    assert.match(root.innerHTML, /id="v6OfflineStart"[^>]*disabled/, 'Start must be disabled while already starting, not re-clickable');
  });

  it('fixture: failed — the diagnostic box shows with Retry & Edit Properties actions', () => {
    const { doc, root } = mountFixture(`
      <div id="v6ChatOfflineHero" class="v6-chat-offline-hero">
        <div class="v6-chat-offline-hero-card">
          <h3 class="v6-chat-offline-hero-title">Launch failed</h3>
          <div class="v6-chat-offline-hero-diagnostic" role="alert">ENGINE_BINARY_MISSING: codex is not installed.</div>
          <div class="v6-chat-offline-hero-actions">
            <button type="button" id="v6OfflineRetry" class="btn btn-primary">↻ Retry</button>
            <button type="button" id="v6OfflineEditProps" class="btn btn-secondary">⚙ Edit Session Properties</button>
          </div>
        </div>
      </div>`);
    assert.match(root.innerHTML, /v6-chat-offline-hero-diagnostic" role="alert">ENGINE_BINARY_MISSING/, 'the diagnostic must actually name the failure category, not a generic message');
    let retried = false;
    doc.getElementById('v6OfflineRetry').addEventListener('click', () => { retried = true; });
    doc.getElementById('v6OfflineRetry').dispatch('click');
    assert.equal(retried, true, 'Retry must be wireable to a click');
  });

  it('fixture: offline history + sidebar actions — the history bar and per-row Rename/Edit/Start controls with an offline status pill', () => {
    const { doc, root } = mountFixture(`
      <div class="v6-chat-offline-history-bar">Showing 4 earlier turns while the session is offline.</div>
      <li class="v6-shell-member">
        <span class="v6-status-pill--offline">offline</span>
        <div class="v6-tree-member-actions">
          <button type="button" id="v6ActRename" class="v6-tree-action-btn" title="Rename">✎</button>
          <button type="button" id="v6ActEditProps" class="v6-tree-action-btn" title="Edit Session Properties">⚙</button>
          <button type="button" id="v6ActStart" class="v6-tree-action-btn" title="Start">▶</button>
        </div>
      </li>`);
    assert.match(root.innerHTML, /class="v6-status-pill--offline">offline</);
    const wired = ['v6ActRename', 'v6ActEditProps', 'v6ActStart'].map((id) => {
      let fired = false;
      doc.getElementById(id).addEventListener('click', () => { fired = true; });
      doc.getElementById(id).dispatch('click');
      return fired;
    });
    assert.deepEqual(wired, [true, true, true], 'all three per-row actions must be independently wireable');
  });
});

/**
 * Car V659-W2-C R2 (#3218, R-Gate R1 BLOCKING 1/2, WARNING 1): the Admin
 * Fleet chat workspace PR #3231 (Car V659-W2-E, addMasterChatWorkspace in
 * public/ui.js) mounts into #masterPanel needs a bounded height budget
 * (BLOCKING 1) and the attach button override (BLOCKING 2) this car's own
 * public/style.css additions provide — pinned here as a stylesheet
 * contract, same pattern the other Car-named describes in this file
 * already use for their own CSS.
 */
describe('Car V659-W2-C R2: Master chat workspace height budget and attach-button positioning (#3218)', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  /**
   * @param {string} selector @returns {string} the selector's own `{ ... }` body, or '' if not found.
   * Escapes `^` too, unlike this file's other copies of this helper — the
   * fleet-start-button selectors below are `[id^="..."]` attribute
   * selectors, and an unescaped `^` outside a character class asserts
   * "start of string" (no `m` flag here), which can never match mid-pattern
   * and silently returns '' for every caller, not just this one.
   */
  const body = (selector) => {
    const m = new RegExp(`(^|\\n)${selector.replace(/[.[\]>="^-]/g, '\\$&')} \\{([^}]*)\\}`).exec(css);
    return m ? m[2] : '';
  };

  it('.master-panel.open becomes a flex column with a scroll safety net, so the chat workspace and #masterFrame can share its 80vh', () => {
    const rule = body('.master-panel.open');
    assert.match(rule, /display: flex;/);
    assert.match(rule, /flex-direction: column;/);
    assert.match(rule, /overflow-y: auto;/);
  });

  it('.master-chat-workspace and .master-chat-stream each get a bounded height budget, not an unbounded flex share', () => {
    const workspace = body('.master-chat-workspace');
    assert.match(workspace, /max-height: 38vh;/);
    assert.match(workspace, /flex: 0 1 auto;/);
    const stream = body('.master-chat-stream');
    assert.match(stream, /flex: 1 1 auto;/);
    assert.match(stream, /min-height: 72px;/);
    assert.match(stream, /max-height: 24vh;/);
    assert.match(stream, /overflow-y: auto;/, 'the stream must scroll internally rather than push the composer/terminal off-budget');
  });

  it('.master-chat-composer positions #masterChatAttachBtn/.v6-chat-attach-btn inline, not as an escaping absolute overlay', () => {
    assert.match(body('.master-chat-composer'), /position: relative;/);
    const override = body('.master-chat-composer .v6-chat-attach-btn,\n.master-chat-composer #masterChatAttachBtn');
    assert.match(override, /position: static;/);
    assert.match(override, /flex: 0 0 auto;/);
  });

  it('the per-row fleet-start buttons ([id^="v6TreeStartFleet-"]/[id^="v6OverviewStartFleet-"]) still carry their own styling', () => {
    const rule = body('[id^="v6TreeStartFleet-"],\n[id^="v6OverviewStartFleet-"]');
    assert.match(rule, /border-radius: var\(--radius-pill\);/);
  });
});

/**
 * Car V6510-W1-C (#3206, #3207, #3208, #3209 — Sprint v6.5.10 Wave C,
 * Milestone #104). Exclusive file scope: public/style.css and this file
 * only. `public/v6-shell.js`/`public/api-helper.js` are NOT in scope — the
 * real markup/wiring these selectors style lives in two OPEN sibling PRs
 * (checked directly, not assumed): PR #3240 (#3207's loading-label wiring
 * + #3208's Content-Type fix) and PR #3233 (#3207's animated-ellipsis
 * controller + #3209's per-engine card helpers, in public/api-helper.js).
 * Neither has merged as of this car's own base commit.
 *
 * #3206 (sub-100ms click feedback) and #3208 (Content-Type header on the
 * usage-probe POSTs) are NOT covered by a test here, and that omission is
 * deliberate, not an oversight:
 * - #3206's own fix is reordering `handleRoute`'s synchronous visual
 *   feedback before its sequential awaits (public/v6-shell.js:6716) — a
 *   `public/v6-shell.js` change outside this car's envelope, unfixed by
 *   either sibling PR above. A wall-clock "<100ms" assertion against this
 *   file's own in-process mounted-shell harness (handleRequest called
 *   directly, no real network) would also be VACUOUS either way — there is
 *   no real latency here for a sequential-vs-parallel difference to show
 *   up against, so the assertion would pass regardless of whether the
 *   underlying ordering bug is fixed. Flagged to the PM rather than
 *   shipping a test that cannot actually fail on the bug it names.
 * - #3208's fix (adding `Content-Type: application/json` to
 *   `refreshUsageProbeAction`/`setUsageProbeIntervalAction`,
 *   `public/v6-shell.js:5687`/`5708`) is real and unmerged — confirmed
 *   directly: `server.js`'s own body-parser guard
 *   (`server.js:8223`, `ownApiSurface && hasBody && declaredType !==
 *   'application/json'`) does reject exactly this today. Still outside
 *   this car's envelope (`public/v6-shell.js`) and mid-review in PR #3240
 *   already — writing a test for it here would either duplicate that PR's
 *   own fix verification or fail until it merges, for a bug this car's own
 *   scope cannot close.
 */
describe('Car V6510-W1-C: shared loading indicator & per-engine usage card styling (#3207, #3209)', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  /** @param {string} selector @returns {string} the selector's own `{ ... }` body, or '' if not found. */
  const body = (selector) => {
    const m = new RegExp(`(^|\\n)${selector.replace(/[.[\]>="^-]/g, '\\$&')} \\{([^}]*)\\}`).exec(css);
    return m ? m[2] : '';
  };

  it('.v6-loading-indicator/.v6-loading-ellipsis are layout-only (no @keyframes of their own), since the JS controller already owns the dot-cycling and its own prefers-reduced-motion check', () => {
    assert.match(body('.v6-loading-indicator'), /display: inline-flex;/);
    assert.match(body('.v6-loading-ellipsis'), /min-width: 1\.5em;/);
    assert.doesNotMatch(css, /\.v6-loading-ellipsis(::after)?\s*\{[^}]*animation:/, 'the dot content is set via JS textContent, not a CSS keyframe — a CSS animation here would double up with it');
  });

  it('.v6-loading-ellipsis drops its width reservation under prefers-reduced-motion, matching the controller\'s own static (non-cycling) render in that mode', () => {
    assert.match(css, /@media \(prefers-reduced-motion: reduce\) \{\s*\/\*[^]*?\*\/\s*\.v6-loading-ellipsis \{\s*min-width: 0;/);
  });

  it('.v6-loading-error/.v6-loading-retry-btn get a visible error treatment and an actionable Retry control', () => {
    assert.match(body('.v6-loading-error'), /color: var\(--danger\);/);
    assert.match(body('.v6-loading-retry-btn'), /cursor: pointer;/);
  });

  it('#v6EngineUsagePopover is bounded and scrolls internally, so multiple engine cards cannot grow past the viewport', () => {
    const rule = body('.v6-usage-popover');
    assert.match(rule, /max-height: min\(75vh, 580px\);/);
    assert.match(rule, /overflow-y: auto;/);
  });

  it('.v6-usage-engine-card groups one provider\'s header, quota windows, sub-tiers, local estimates and degraded note into one bordered card', () => {
    assert.match(body('.v6-usage-engine-card'), /border: 1px solid var\(--border-color, #2a2f36\);/);
    assert.match(body('.v6-usage-card-title'), /font-weight: 600;/);
    assert.match(body('.v6-usage-source-badge--probed'), /color: #56d364;/);
    assert.match(body('.v6-usage-degraded-note'), /color: var\(--danger\);/);
  });

  it('.v6-usage-source-badge--probed gets a darker, WCAG-compliant green under the light theme, without touching the dark value', () => {
    assert.match(css, /\[data-theme="light"\] \.v6-usage-source-badge--probed \{\s*\/\*[^]*?\*\/\s*color: #1a7f37;\s*border-color: #1a7f37;/);
  });

  /**
   * WCAG relative luminance / contrast ratio — the same algorithm this
   * file's own Car V659-W1-C describe block (and `test/theme-contrast
   * .test.js`'s `luminance()`/`contrast()`) already use, duplicated here
   * rather than imported since neither file exports it.
   * @param {string} hex
   * @returns {number}
   */
  function luminance(hex) {
    const h = hex.replace('#', '');
    const [r, g, b] = [0, 2, 4].map((i) => {
      const c = parseInt(h.slice(i, i + 2), 16) / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  /** @param {string} hexA @param {string} hexB @returns {number} */
  function contrastRatio(hexA, hexB) {
    const [l1, l2] = [luminance(hexA), luminance(hexB)].sort((a, b) => b - a);
    return (l1 + 0.05) / (l2 + 0.05);
  }

  it('#3207/#3209 R2 BLOCKING 1: every color this car introduces clears WCAG AA (>= 4.5:1) against its real background, in BOTH themes', () => {
    // Dark theme: --danger is #EF5350 (:root), card background #0d0d0d
    // (.v6-usage-popover's own var(--card-bg, #0d0d0d) fallback, which is
    // what actually resolves since :root always defines --card-bg).
    assert.ok(contrastRatio('#EF5350', '#0d0d0d') >= 4.5, 'var(--danger) (dark) on the dark card background');
    // #56d364 is the UNCHANGED dark-theme value for the probed badge.
    assert.ok(contrastRatio('#56d364', '#0d0d0d') >= 4.5, '.v6-usage-source-badge--probed (dark) on the dark card background');
    // Light theme: --danger is #8f3230 (:root[data-theme="light"]), card
    // background #FFFFFF.
    assert.ok(contrastRatio('#8f3230', '#FFFFFF') >= 4.5, 'var(--danger) (light) on the light card background');
    // #1a7f37 is this car's own light-theme override for the probed badge.
    assert.ok(contrastRatio('#1a7f37', '#FFFFFF') >= 4.5, '.v6-usage-source-badge--probed (light override) on the light card background');
  });

  it('.v6-usage-window-row renders a real progress track behind .v6-usage-progress-bar\'s own inline width, in the SAME grid cell — the markup never nests a separate track element', () => {
    const row = body('.v6-usage-window-row');
    assert.match(row, /display: grid;/);
    assert.match(row, /grid-template-columns: 7em minmax\(60px, 1fr\) 4\.5em auto;/);
    const track = body('.v6-usage-window-row::before');
    assert.match(track, /grid-column: 2;/);
    assert.match(track, /background: var\(--elevated-bg, #1a1a1a\);/);
    const bar = body('.v6-usage-progress-bar');
    assert.match(bar, /grid-column: 2;/, 'the fill must share the track\'s own grid cell, not a different one, to visually overlay it');
    assert.match(bar, /background: var\(--primary, #8bc34a\);/);
  });

  /**
   * R-Gate R1 BLOCKING 2: go beyond regex-against-CSS-text by mounting
   * the REAL markup SHAPE `tcV6AnimatedEllipsisMarkup`/
   * `tcV6CreateAnimatedEllipsisController`/`tcV6RenderEngineUsageCardMarkup`
   * (`public/api-helper.js`, PR #3233 — `tcV6BindAnimatedEllipsis`/
   * `tcV6RenderEngineUsagePopoverCards`, as the review named them, do not
   * exist; grepped that branch's own `global.tcV6*` exports directly,
   * there are exactly 4) actually produce, and proving this car's CSS
   * selectors target that real shape — not a hand-invented one.
   *
   * Honest limit, stated rather than silently worked around: this file's
   * mini-DOM (`test/_mini-dom.js`) has no real CSSOM or layout engine —
   * it cannot compute an actual rendered color, a real contrast ratio
   * against a painted background, or genuine pixel overlap between
   * elements. The numeric WCAG test above already covers color/contrast
   * the only way this harness CAN (computing it directly from the same
   * hex values the CSS declares, verified against the real rule text).
   * What mounting real markup adds that a pure text-regex check cannot:
   * proving the exact classes/structure these functions actually emit
   * are what this car's selectors actually match — the fixtures below
   * are copied verbatim from PR #3233's own source, not reconstructed
   * from memory, and the test fails if either drifts from the other.
   */
  describe('Mounted fixtures against the real PR #3233 markup shape', () => {
    /**
     * A minimal tag-stack HTML -> mini-DOM builder for THIS block's own
     * fixtures — the same bounded technique (and the same reason:
     * `withIdParsingInnerHTML` only extracts flat id stand-ins, and none
     * of these fixtures carry an id at all) the #3218 describe earlier in
     * this file already uses for `public/index.html`'s real markup.
     * @param {object} doc
     * @param {string} html
     * @returns {object} The root element.
     */
    function mountFixtureMarkup(doc, html) {
      const clean = html.replace(/<!--[\s\S]*?-->/g, '');
      const tagRe = /<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>/g;
      const stack = [];
      let root = null;
      let cursor = 0;
      let match;
      while ((match = tagRe.exec(clean))) {
        const textBefore = clean.slice(cursor, match.index);
        cursor = match.index + match[0].length;
        if (stack.length && textBefore) {
          stack[stack.length - 1].textContent = (stack[stack.length - 1].textContent || '') + textBefore;
        }
        const [, closing, tag, attrs] = match;
        if (closing) { stack.pop(); continue; }
        const el = doc.createElement(tag);
        const classMatch = /\bclass="([^"]*)"/.exec(attrs);
        if (classMatch) el.className = classMatch[1];
        const dataRe = /\bdata-([a-z-]+)="([^"]*)"/g;
        let dataMatch;
        while ((dataMatch = dataRe.exec(attrs))) {
          el.dataset[dataMatch[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = dataMatch[2];
        }
        if (stack.length) stack[stack.length - 1].appendChild(el);
        else root = el;
        stack.push(el);
      }
      return root;
    }

    it('the loading indicator\'s success state (tcV6AnimatedEllipsisMarkup) and failed state (the controller\'s own fail()) both mount with exactly the classes this car\'s CSS targets', () => {
      const { doc } = makeDocument([]);
      // Verbatim from tcV6AnimatedEllipsisMarkup's own return (PR #3233).
      const loading = mountFixtureMarkup(doc, '<span class="v6-loading-indicator" role="status" aria-live="polite" data-v6-loading-stem="Loading chat" data-v6-loading-state="loading"><span class="v6-loading-label">Loading chat</span><span class="v6-loading-ellipsis" aria-hidden="true">...</span></span>');
      assert.equal(loading.className, 'v6-loading-indicator');
      assert.equal(loading.childNodes[0].className, 'v6-loading-label');
      assert.equal(loading.childNodes[1].className, 'v6-loading-ellipsis');
      // Verbatim from the controller's own fail() DOM-building (PR #3233):
      // containerEl.innerHTML = ''; then an errEl.className =
      // 'v6-loading-error' with a nested Retry btn.className =
      // 'v6-loading-retry-btn' wired to retryOpts.onRetry.
      const { doc: doc2 } = makeDocument([]);
      const failed = mountFixtureMarkup(doc2, '<span class="v6-loading-error" role="alert">Failed.<button type="button" class="v6-loading-retry-btn">Retry</button></span>');
      assert.equal(failed.className, 'v6-loading-error');
      const retryBtn = failed.childNodes.find((c) => c.className === 'v6-loading-retry-btn');
      assert.ok(retryBtn, 'the real fail() state always nests a Retry button when onRetry is given');
      let retried = false;
      retryBtn.addEventListener('click', () => { retried = true; });
      retryBtn.dispatch('click');
      assert.equal(retried, true, 'the retry control must stay a normal, click-wireable button in the error state this car styles');
    });

    it('3 real per-engine cards (tcV6RenderEngineUsageCardMarkup\'s own output, claude/codex/antigravity) mount as 3 structurally distinct, non-overlapping sections with unique providers', () => {
      const { doc } = makeDocument([]);
      // Verbatim shape from tcV6RenderEngineUsageCardMarkup's own return
      // (PR #3233) for one provider; repeated for the 3 real engines this
      // popover always lists (TC_V6_USAGE_PROVIDER_TITLES).
      const cardHtml = (provider, title, pct) => `<section class="v6-usage-engine-card" data-usage-provider="${provider}">
        <header class="v6-usage-card-header">
          <h4 class="v6-usage-card-title">${title}</h4>
          <span class="v6-usage-source-badge--probed">Provider Probed</span>
        </header>
        <div class="v6-usage-window-row" data-usage-window="five-hour">
          <span class="v6-usage-window-label">5-Hour Quota Window</span>
          <div class="v6-usage-progress-bar"></div>
          <span class="v6-usage-pct-left">${pct}% left</span>
        </div>
        <div class="v6-usage-local-estimates">
          <h5>Local Transcript Token &amp; Session Aggregates</h5>
        </div>
      </section>`;
      const popoverHtml = [cardHtml('claude', 'Claude', 60), cardHtml('codex', 'Codex', 45), cardHtml('antigravity', 'Antigravity', 80)].join('');
      const wrapper = mountFixtureMarkup(doc, `<div>${popoverHtml}</div>`);
      const cards = wrapper.childNodes.filter((c) => c.className === 'v6-usage-engine-card');
      assert.equal(cards.length, 3, 'all 3 engines must mount as their own card, none swallowed into a sibling');
      const providers = cards.map((c) => c.dataset.usageProvider);
      assert.deepEqual(providers, ['claude', 'codex', 'antigravity'], 'each card keeps its own distinct provider — none overlap or duplicate');
      cards.forEach((card) => {
        const header = card.childNodes.find((c) => c.className === 'v6-usage-card-header');
        assert.ok(header, 'every card keeps its own header as a direct child, never reaching into a sibling card');
        assert.equal(card.querySelector('.v6-usage-window-row').parentNode, card, 'the window row stays nested in its OWN card, not a sibling\'s');
      });
    });
  });
});
