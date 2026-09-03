'use strict';

/*
 * #542 — served plan docs over a REAL HTTP server: the page route, the
 * listing route with its operator-facing origin, the traversal refusals as
 * they arrive on the wire (percent-encoded, symlinked), the archived/absent
 * 404 pages, the whoami capability, and auth PARITY — the page takes exactly
 * the gate the dashboard takes and the listing exactly the gate its
 * `/api/projects` siblings take; no new gate, no bypass.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const caddy = require('../lib/caddy');
const httpsSetup = require('../lib/https-setup');
const serviceToken = require('../lib/service-token');
const sessionOwnership = require('../lib/session-ownership');
const { createServer } = require('../server');

/**
 * HTTP request; returns status, headers, the raw body and its JSON when it is JSON.
 * @param {import('node:http').Server} server
 * @param {string} urlPath - Path, possibly percent-encoded
 * @param {object} [extraHeaders]
 * @returns {Promise<{status: number, headers: object, body: string, data: object|null}>}
 */
function get(server, urlPath, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port: server.address().port,
      path: urlPath,
      method: 'GET',
      headers: extraHeaders
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = JSON.parse(body); } catch { data = null; }
        resolve({ status: res.statusCode, headers: res.headers, body, data });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('#542 — served plan docs over HTTP', () => {
  let tmpDir;
  let server;
  let project;
  let realExec;
  let realHostname;
  const HOST = 'dev-box.example';

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-plan-docs-'));
    store._setBasePath(path.join(tmpDir, 'tangleclaw'));
    store.init();

    const projDir = path.join(tmpDir, 'proj');
    const tcDir = path.join(projDir, '.tangleclaw', 'plans');
    const legacyDir = path.join(projDir, '.claude', 'plans');
    fs.mkdirSync(path.join(tcDir, 'archive'), { recursive: true });
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(tcDir, 'train.md'),
      '# Train 12 — Demo\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\n<script>alert(1)</script>\n```\n');
    fs.writeFileSync(path.join(tcDir, 'archive', 'shipped.md'), '# Shipped\n');
    fs.writeFileSync(path.join(legacyDir, 'legacy.md'), '# Legacy plan\n');
    const outside = path.join(tmpDir, 'secret.md');
    fs.writeFileSync(outside, 'SECRET-MARKER');
    fs.symlinkSync(outside, path.join(tcDir, 'escape.md'));

    project = store.projects.create({ name: 'plans-proj', path: projDir, engine: 'claude' });

    // Deterministic host probe: no tailscale, a known machine name.
    realExec = sessionOwnership._internal.execSync;
    realHostname = sessionOwnership._internal.hostname;
    sessionOwnership._internal.execSync = () => { throw new Error('no tailscale'); };
    sessionOwnership._internal.hostname = () => 'plans-host';
    sessionOwnership._resetHostCacheForTest();

    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    sessionOwnership._internal.execSync = realExec;
    sessionOwnership._internal.hostname = realHostname;
    sessionOwnership._resetHostCacheForTest();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('GET /plans/:projectId/:file', () => {
    it('renders the plan as a theme-aware HTML page', async () => {
      const r = await get(server, `/plans/${project.id}/train.md`);
      assert.equal(r.status, 200);
      assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
      assert.equal(r.headers['x-content-type-options'], 'nosniff');
      assert.match(r.body, /<h1 id="train-12-demo">Train 12 — Demo<\/h1>/);
      assert.match(r.body, /<title>Train 12 — Demo · plans-proj · TangleClaw<\/title>/);
      assert.match(r.body, /@media \(prefers-color-scheme:dark\)/);
      assert.match(r.body, /<div class="table-scroll"><table>/);
      assert.match(r.body, /overflow-x:auto/);
      // The fenced script is text, and the page carries no script of its own.
      assert.match(r.body, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
      assert.doesNotMatch(r.body, /<script/);
    });

    it('sends a Content-Security-Policy that allows only the inline stylesheet, on the page and its refusals', async () => {
      const csp = "default-src 'none'; style-src 'unsafe-inline'; img-src https: data:";
      assert.equal((await get(server, `/plans/${project.id}/train.md`)).headers['content-security-policy'], csp);
      assert.equal((await get(server, `/plans/${project.id}/never.md`)).headers['content-security-policy'], csp);
    });

    it('answers a 500 page, not a hung socket, when the renderer throws', async () => {
      const planDocs = require('../lib/plan-docs');
      const real = planDocs.renderPlanPage;
      planDocs.renderPlanPage = () => { throw new RangeError('Maximum call stack size exceeded'); };
      try {
        const r = await get(server, `/plans/${project.id}/train.md`);
        assert.equal(r.status, 500);
        assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
        assert.match(r.body, /<h1>Plan could not be rendered<\/h1>/);
      } finally {
        planDocs.renderPlanPage = real;
      }
    });

    it('accepts the project id as decimal digits only — 0x1 / 1e0 spellings do not resolve', async () => {
      const hex = '0x' + project.id.toString(16);
      const r = await get(server, `/plans/${hex}/train.md`);
      assert.equal(r.status, 404);
      assert.match(r.body, /No project has the id/);
      assert.equal((await get(server, `/plans/${project.id}e0/train.md`)).status, 404);
    });

    it('falls back to the legacy plans directory', async () => {
      const r = await get(server, `/plans/${project.id}/legacy.md`);
      assert.equal(r.status, 200);
      assert.match(r.body, /Legacy plan/);
      assert.match(r.body, /<code>\.claude\/plans\/legacy\.md<\/code>/);
    });

    it('refuses traversal-shaped names with a 400 page, before any read', async () => {
      for (const p of [
        `/plans/${project.id}/..%2F..%2Fsecret.md`,
        `/plans/${project.id}/%2e%2e%2Fsecret.md`,
        `/plans/${project.id}/archive%2Fshipped.md`,
        `/plans/${project.id}/train.md%00`,
        `/plans/${project.id}/train.txt`,
        `/plans/${project.id}/%E0%A4%A`
      ]) {
        const r = await get(server, p);
        assert.equal(r.status, 400, p);
        assert.equal(r.headers['content-type'], 'text/html; charset=utf-8', p);
        assert.match(r.body, /Invalid plan name/, p);
        assert.doesNotMatch(r.body, /SECRET-MARKER/, p);
      }
    });

    it('refuses a symlink that leaves the plans directory (404, nothing leaked)', async () => {
      const r = await get(server, `/plans/${project.id}/escape.md`);
      assert.equal(r.status, 404);
      assert.match(r.body, /Plan not found/);
      assert.doesNotMatch(r.body, /SECRET-MARKER/);
    });

    it('answers 404 with a plain HTML page naming an archived plan as archived', async () => {
      const r = await get(server, `/plans/${project.id}/shipped.md`);
      assert.equal(r.status, 404);
      assert.equal(r.headers['content-type'], 'text/html; charset=utf-8');
      assert.match(r.body, /<h1>Plan archived<\/h1>/);
      assert.match(r.body, /shipped\.md has been archived in plans-proj/);
    });

    it('answers 404 for an absent plan, an unknown project, and a malformed path', async () => {
      const absent = await get(server, `/plans/${project.id}/never.md`);
      assert.equal(absent.status, 404);
      assert.match(absent.body, /has no plan named never\.md in \.tangleclaw\/plans or \.claude\/plans/);

      const noProject = await get(server, '/plans/999999/train.md');
      assert.equal(noProject.status, 404);
      assert.match(noProject.body, /No project has the id 999999/);

      const short = await get(server, `/plans/${project.id}`);
      assert.equal(short.status, 404);
      assert.match(short.body, /addressed as \/plans\/&lt;projectId&gt;\/&lt;file&gt;\.md/);
    });
  });

  describe('GET /api/projects/:project/plans', () => {
    /** The port the front door carries outside caddy mode: the configured server port. */
    const frontPort = () => httpsSetup.effectiveServerPort(store.config.load());

    it('lists served plans with absolute URLs on the host the caller reached TangleClaw on', async () => {
      const r = await get(server, `/api/projects/${project.id}/plans`, { Host: `${HOST}:3102` });
      assert.equal(r.status, 200);
      assert.deepEqual(r.data.project, { id: project.id, name: 'plans-proj' });
      assert.deepEqual(r.data.plansDirs, ['.tangleclaw/plans', '.claude/plans']);
      assert.equal(r.data.origin, `http://${HOST}:${frontPort()}`);
      assert.equal(r.data.originSource, 'host');
      assert.deepEqual(r.data.plans.map((p) => p.file), ['train.md', 'legacy.md']);
      const train = r.data.plans[0];
      assert.equal(train.urlPath, `/plans/${project.id}/train.md`);
      assert.equal(train.url, `http://${HOST}:${frontPort()}/plans/${project.id}/train.md`);
      assert.equal(train.legacy, false);
      assert.equal(train.relative, '.tangleclaw/plans/train.md');
      assert.ok(path.isAbsolute(train.path));
      assert.equal(r.data.plans[1].legacy, true);
    });

    it('every listed URL answers 200 when fetched', async () => {
      const r = await get(server, `/api/projects/${project.id}/plans`, { Host: `${HOST}:3102` });
      for (const p of r.data.plans) {
        const page = await get(server, p.urlPath);
        assert.equal(page.status, 200, p.urlPath);
      }
    });

    it('accepts the project name as well as its id', async () => {
      const r = await get(server, '/api/projects/plans-proj/plans', { Host: `${HOST}:3102` });
      assert.equal(r.status, 200);
      assert.equal(r.data.project.id, project.id);
    });

    it('a loopback caller gets the probed machine name, never localhost', async () => {
      const r = await get(server, `/api/projects/${project.id}/plans`, { Host: `127.0.0.1:${server.address().port}` });
      assert.equal(r.status, 200);
      assert.equal(r.data.origin, `http://plans-host:${frontPort()}`);
      assert.equal(r.data.originSource, 'local-probe');
      assert.doesNotMatch(r.data.plans[0].url, /localhost|127\.0\.0\.1/);
    });

    it('in caddy mode the origin is the HTTPS front door, not this listener', async () => {
      const config = store.config.load();
      const saved = { ingressMode: config.ingressMode, caddyHttpsPort: config.caddyHttpsPort };
      config.ingressMode = 'caddy';
      config.caddyHttpsPort = 8443;
      store.config.save(config);
      try {
        const r = await get(server, `/api/projects/${project.id}/plans`, { Host: `${HOST}:8443` });
        assert.equal(r.status, 200);
        assert.equal(r.data.origin, `https://${HOST}:8443`);
        assert.equal(r.data.plans[0].url, `https://${HOST}:8443/plans/${project.id}/train.md`);
      } finally {
        const restore = store.config.load();
        restore.ingressMode = saved.ingressMode;
        restore.caddyHttpsPort = saved.caddyHttpsPort;
        store.config.save(restore);
      }
    });

    it('404s an unknown project as JSON', async () => {
      const r = await get(server, '/api/projects/no-such-project/plans');
      assert.equal(r.status, 404);
      assert.equal(r.data.code, 'NOT_FOUND');
    });
  });

  describe('auth parity — the same gates every other page and API route take', () => {
    it('neither path is a Caddy auth-bypass path (basic_auth gates them like the dashboard)', () => {
      assert.equal(caddy.isCaddyAuthBypassPath(`/plans/${project.id}/train.md`), false);
      assert.equal(caddy.isCaddyAuthBypassPath(`/api/projects/${project.id}/plans`), false);
      assert.equal(caddy.isCaddyAuthBypassPath('/plans/1/../openclaw-direct/x'), false);
    });

    it('under the M2M service-token gate the page behaves as the dashboard and the listing as its siblings', async () => {
      const config = store.config.load();
      config.serviceTokenEnabled = true;
      config.serviceToken = serviceToken.generateToken();
      store.config.save(config);
      try {
        // The gate is live: a gated surface refuses without the bearer.
        assert.equal((await get(server, '/api/ports')).status, 401);
        // Pages: the dashboard and the plan page answer identically.
        assert.equal((await get(server, '/')).status, 200);
        assert.equal((await get(server, `/plans/${project.id}/train.md`)).status, 200);
        // API: the projects family and the listing answer identically.
        assert.equal((await get(server, '/api/projects/plans-proj')).status, 200);
        assert.equal((await get(server, `/api/projects/${project.id}/plans`)).status, 200);
      } finally {
        const restore = store.config.load();
        restore.serviceTokenEnabled = false;
        store.config.save(restore);
      }
    });
  });

  describe('discovery', () => {
    it('tc whoami/capabilities carries plan-docs with the listing endpoint for a resolved project', async () => {
      const r = await get(server, `/api/tc/whoami?projectId=${project.id}`);
      assert.equal(r.status, 200);
      const cap = r.data.capabilities.find((c) => c.id === 'plan-docs');
      assert.ok(cap, 'plan-docs capability present');
      assert.equal(cap.enabled, true);
      assert.match(cap.detail, new RegExp(`/api/projects/${project.id}/plans`));
      assert.match(cap.detail, new RegExp(`/plans/${project.id}/<file>\\.md`));
    });

    it('reports plan-docs as unavailable, not absent, when no project resolved', async () => {
      const r = await get(server, '/api/tc/whoami');
      const cap = r.data.capabilities.find((c) => c.id === 'plan-docs');
      assert.ok(cap);
      assert.equal(cap.enabled, false);
      assert.match(cap.detail, /unavailable/);
    });
  });
});
