'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const store = require('../lib/store');
const { handleRequest } = require('../server');
const medusaV2 = require('../lib/v6/medusa-v2-compact-sync');

// v6.2.0 Wave 2 (Car V62-W2-ROUTES): live HTTP wiring for the five Wave 1
// modules (#3001..#3005), driven through the REAL request handler, plus the
// v6 shell's Platform and what-if views. The security invariants each have
// a test: server-owned advisor roots/limits/clock, the rate check before
// any read, server-only sandboxing host facts with no environment leak,
// and a compact-wire route that writes nothing.

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

describe('v6.2.0 Wave 2 server routes (#3001..#3005)', () => {
  let tempDir;
  let prevBase;

  before(() => {
    prevBase = store._getBasePath();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-v620-routes-'));
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

  /** @returns {object} A minimal response double. */
  function mockRes() {
    return {
      statusCode: 0, body: '', headers: {},
      setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
      writeHead(status, headers) {
        this.statusCode = status;
        for (const [k, v] of Object.entries(headers || {})) this.headers[k.toLowerCase()] = v;
      },
      end(chunk) { if (chunk != null) this.body = String(chunk); }
    };
  }

  /**
   * Drive one request through the real handler, as the dashboard operator
   * unless `operator: false`.
   * @param {string} method
   * @param {string} url
   * @param {{body?: object, operator?: boolean}} [opts]
   * @returns {Promise<object>}
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
      on(event, cb) {
        if (event === 'data' && raw !== null) cb(Buffer.from(raw));
        if (event === 'end') cb();
      }
    };
    const res = mockRes();
    await handleRequest(req, res);
    return res;
  }
  const post = (url, body, opts) => send('POST', url, Object.assign({ body: body || {} }, opts));
  const get = (url, opts) => send('GET', url, opts);
  const json = (res) => JSON.parse(res.body);

  describe('every route refuses a caller that is not the operator', () => {
    for (const [method, url] of [
      ['POST', '/api/v6/whatif/simulate'], ['POST', '/api/v6/whatif/compare'],
      ['GET', '/api/v6/providers/g2b'], ['POST', '/api/v6/providers/g2b/normalize'],
      ['GET', '/api/v6/advisor/usage?tenantId=t'], ['POST', '/api/v6/advisor/advise'],
      ['GET', '/api/v6/medusa-v2/status'], ['POST', '/api/v6/medusa-v2/compact'],
      ['GET', '/api/v6/sandboxing/status'], ['POST', '/api/v6/sandboxing/plan']
    ]) {
      it(`${method} ${url}`, async () => {
        const res = await send(method, url, { operator: false, body: method === 'GET' ? undefined : {} });
        assert.ok([401, 403].includes(res.statusCode), `${res.statusCode} ${res.body}`);
      });
    }
  });

  describe('E3b what-if routes (#3001)', () => {
    const scenario = { trains: [{ id: 't', cars: [{ id: 'a', effort: 2 }, { id: 'b', effort: 1, dependsOn: ['a'] }] }], rolePools: { Builder: 1 } };

    it('simulates a scenario and refuses a malformed one', async () => {
      const ok = json(await post('/api/v6/whatif/simulate', { scenario }));
      assert.deepEqual([ok.makespan, ok.complete, ok.criticalPath.carIds], [3, true, ['a', 'b']]);
      const bad = await post('/api/v6/whatif/simulate', { scenario: { trains: [] } });
      assert.deepEqual([bad.statusCode, json(bad).code], [400, 'SCENARIO_INVALID']);
    });

    it('compares variants against a baseline', async () => {
      const out = json(await post('/api/v6/whatif/compare', { baseline: scenario, variants: [{ name: 'two-lanes', scenario: { ...scenario, rolePools: { Builder: 2 } } }] }));
      assert.equal(out.baseline.makespan, 3);
      assert.equal(out.variants[0].name, 'two-lanes');
    });
  });

  describe('G2b provider routes (#3002)', () => {
    it('lists the four adapters with their capabilities and a passing contract check', async () => {
      const out = json(await get('/api/v6/providers/g2b'));
      assert.deepEqual(out.providers.map((p) => p.name), ['gitlab', 'jira', 'linear', 'dolt']);
      assert.equal(out.contract.ok, true);
      assert.ok(out.providers.find((p) => p.name === 'dolt').unsupported.includes('inboundWebhooks'));
    });

    it('exercises validateConfig, mapOutboundEvent and normalizeInboundEvent offline', async () => {
      assert.deepEqual(json(await post('/api/v6/providers/g2b/normalize', { provider: 'gitlab', op: 'validateConfig', config: { repo: 'g/p', tokenRef: 'vault:x' } })), { ok: true });
      const mapped = json(await post('/api/v6/providers/g2b/normalize', { provider: 'gitlab', op: 'mapOutboundEvent', action: 'createIssue', repo: 'g/p', draft: { title: 'T' } }));
      assert.equal(mapped.url, 'https://gitlab.com/api/v4/projects/g%2Fp/issues');
      const inbound = json(await post('/api/v6/providers/g2b/normalize', { provider: 'jira', op: 'normalizeInboundEvent',
        headers: { 'x-atlassian-webhook-identifier': '42' }, payload: { webhookEvent: 'jira:issue_created', issue: { fields: { project: { key: 'TC' } } } } }));
      assert.deepEqual([inbound.repo, inbound.deliveryId], ['TC', '42']);
      assert.equal(json(await post('/api/v6/providers/g2b/normalize', { provider: 'github', op: 'validateConfig' })).code, 'UNKNOWN_PROVIDER');
      assert.equal(json(await post('/api/v6/providers/g2b/normalize', { provider: 'gitlab', op: 'testConnection' })).code, 'UNKNOWN_OP');
    });
  });

  describe('G4 advisor routes (#3003)', () => {
    let reposRoot;
    let prevEnv;

    before(() => {
      prevEnv = process.env.TANGLECLAW_ADVISOR_REPOS_ROOT;
      // Explicitly under /tmp: os.tmpdir() on macOS is under /var, which the
      // advisor protects, and a repos root inside a protected root is refused.
      reposRoot = fs.mkdtempSync('/tmp/tc-v620-advisor-repos-');
      fs.mkdirSync(path.join(reposRoot, 'acme', 'widgets'), { recursive: true });
      fs.writeFileSync(path.join(reposRoot, 'acme', 'widgets', 'README.md'), 'Widgets readme. token=ghp_' + 'A'.repeat(36) + '\n');
    });
    after(() => {
      if (prevEnv === undefined) delete process.env.TANGLECLAW_ADVISOR_REPOS_ROOT; else process.env.TANGLECLAW_ADVISOR_REPOS_ROOT = prevEnv;
      fs.rmSync(reposRoot, { recursive: true, force: true });
    });

    it('refuses every server-owned field, including an arbitrary host repoRoot like /etc', async () => {
      process.env.TANGLECLAW_ADVISOR_REPOS_ROOT = reposRoot;
      for (const field of ['repoRoot', 'protectedRoots', 'advisorRoot', 'limits', 'now', 'estimate', 'maxBytes']) {
        const value = field === 'repoRoot' ? '/etc' : field === 'now' ? 0 : field === 'protectedRoots' ? [] : {};
        const res = await post('/api/v6/advisor/advise', { tenantId: 'acme', repoSlug: 'widgets', relativePath: 'README.md', [field]: value });
        assert.deepEqual([res.statusCode, json(res).code], [400, 'SERVER_OWNED_FIELD'], field);
      }
    });

    it('answers 503 when no approved repositories root is configured, never falling back', async () => {
      delete process.env.TANGLECLAW_ADVISOR_REPOS_ROOT;
      const res = await post('/api/v6/advisor/advise', { tenantId: 'acme', repoSlug: 'widgets', relativePath: 'README.md' });
      assert.deepEqual([res.statusCode, json(res).code], [503, 'ADVISOR_REPOS_UNCONFIGURED']);
      process.env.TANGLECLAW_ADVISOR_REPOS_ROOT = '/etc';
      const protectedRoot = await post('/api/v6/advisor/advise', { tenantId: 'acme', repoSlug: 'widgets', relativePath: 'hosts' });
      assert.notEqual(protectedRoot.statusCode, 200, 'a repos root configured inside a protected root still reads nothing');
    });

    it('reads a scrubbed file from the approved tenant repository, charging the server-set worst case', async () => {
      process.env.TANGLECLAW_ADVISOR_REPOS_ROOT = reposRoot;
      const res = await post('/api/v6/advisor/advise', { tenantId: 'acme', repoSlug: 'widgets', relativePath: 'README.md' });
      assert.equal(res.statusCode, 200, res.body);
      const out = json(res);
      assert.match(out.file.text, /Widgets readme/);
      assert.ok(!out.file.text.includes('ghp_' + 'A'.repeat(36)), 'output passes the F3 scrubber');
      assert.deepEqual(out.charged, { tokens: 8192, usd: 0 });
      const usage = json(await get('/api/v6/advisor/usage?tenantId=acme'));
      assert.equal(usage.usage.tokens, 8192);
    });

    it('refuses traversal, an internal identity and an unapproved repository', async () => {
      process.env.TANGLECLAW_ADVISOR_REPOS_ROOT = reposRoot;
      assert.notEqual((await post('/api/v6/advisor/advise', { tenantId: 'acme', repoSlug: 'widgets', relativePath: '../../etc/hosts' })).statusCode, 200);
      assert.equal(json(await post('/api/v6/advisor/advise', { tenantId: 'acme', repoSlug: 'widgets', relativePath: 'README.md', projectId: 1 })).code, 'PROJECT_SCOPE_DENIED');
      assert.notEqual((await post('/api/v6/advisor/advise', { tenantId: 'acme', repoSlug: 'not-approved', relativePath: 'README.md' })).statusCode, 200);
      assert.equal(json(await post('/api/v6/advisor/advise', { tenantId: '../acme', repoSlug: 'widgets', relativePath: 'README.md' })).code, 'TENANT_INVALID');
    });

    it('checks the rate cap BEFORE reading any file (TC-Lane-C N1)', async () => {
      process.env.TANGLECLAW_ADVISOR_REPOS_ROOT = reposRoot;
      const db = store.getDb();
      const stamp = Date.now();
      const day = new Date(stamp).toISOString().slice(0, 10);
      for (let i = 0; i < 30; i++) {
        db.prepare('INSERT INTO v6_advisor_requests (tenant_id, at_ms, day, tokens, usd_micros, repo_slug, rel_path) VALUES (?,?,?,?,?,?,?)').run('busy', stamp, day, 1, 0, 'widgets', 'x');
      }
      const res = await post('/api/v6/advisor/advise', { tenantId: 'busy', repoSlug: 'widgets', relativePath: 'does-not-exist.md' });
      assert.deepEqual([res.statusCode, json(res).code], [429, 'RATE_LIMIT'], 'refused for rate before any file lookup (a read would have failed differently)');
    });

    it('usage needs a slug tenant id', async () => {
      assert.equal((await get('/api/v6/advisor/usage?tenantId=../x')).statusCode, 400);
    });
  });

  describe('Medusa v2 routes (#3004)', () => {
    it('reports status from SQLite with an honest benchmark note', async () => {
      const out = json(await get('/api/v6/medusa-v2/status'));
      assert.equal(out.storedMessages, 0);
      assert.equal(out.pendingWakes, 0);
      assert.equal(out.benchmark.available, false);
    });

    it('projects and parses a compact card, computes a Merkle root, and writes nothing', async () => {
      const envelope = medusaV2.createEnvelope({ msg_type: 'update' });
      const card = json(await post('/api/v6/medusa-v2/compact', { op: 'project', envelope })).card;
      assert.equal(typeof card, 'string');
      const parsed = json(await post('/api/v6/medusa-v2/compact', { op: 'parse', card }));
      assert.equal(parsed.envelope.msg_type, 'update');
      assert.equal(json(await post('/api/v6/medusa-v2/compact', { op: 'record', envelope })).code, 'UNKNOWN_OP');
      assert.equal(json(await get('/api/v6/medusa-v2/status')).storedMessages, 0, 'the compact route records nothing');
    });
  });

  describe('A1-Iso sandboxing routes (#3005)', () => {
    it('status never returns the server environment', async () => {
      process.env.TC_V620_TEST_SECRET = 'do-not-leak-this-value';
      const res = await get('/api/v6/sandboxing/status');
      delete process.env.TC_V620_TEST_SECRET;
      assert.equal(res.statusCode, 200, res.body);
      assert.ok(!res.body.includes('do-not-leak-this-value'));
      assert.equal(json(res).host.env, undefined);
      assert.deepEqual(json(res).modes, ['shared_uid', 'container', 'separate_unix_uid']);
    });

    it('plans with server-only host facts and refuses any client-supplied host or mount policy', async () => {
      const shared = json(await post('/api/v6/sandboxing/plan', { profile: { mode: 'shared_uid' } }));
      assert.equal(shared.ok, true);
      for (const body of [
        { profile: { mode: 'shared_uid' }, host: { uid: 0 } },
        { profile: { mode: 'shared_uid' }, mountRoots: ['/'] },
        { profile: { mode: 'container', mountRoots: ['/'] } },
        { profile: { mode: 'container', writableRoots: ['/'] } }
      ]) {
        const res = await post('/api/v6/sandboxing/plan', body);
        assert.deepEqual([res.statusCode, json(res).code], [400, 'SERVER_OWNED_FIELD'], JSON.stringify(body));
      }
      const container = await post('/api/v6/sandboxing/plan', { profile: { mode: 'container', requireIsolation: true, runtime: 'docker', image: 'alpine', command: ['true'] } });
      assert.notEqual(json(container).ok, true, 'no probed runtime: an isolation-requiring profile fails closed');
    });
  });

  describe('v6-shell Platform and what-if views', () => {
    const XSS = '<img src=x onerror=alert(1)>';

    it('escapes every server-supplied value', () => {
      const shell = loadV6Shell();
      const html = shell.tcV6PlatformViewMarkup({
        providers: { contract: { ok: true }, providers: [{ name: XSS, actions: { [XSS]: {} }, unsupported: [XSS] }] },
        medusa: { capability: XSS, storedMessages: XSS, pendingWakes: XSS, latestSnapshotRoot: XSS },
        sandboxing: { modes: [XSS], host: { runtimes: {}, canSwitchUid: false }, defaultPlan: { ok: true, mode: XSS } }
      }) + shell.tcV6WhatIfMarkup({ result: { makespan: 1, complete: false, criticalPath: { carIds: [XSS] }, bottlenecks: { [XSS]: { laneWait: XSS, fileWait: 0, quotaWait: 0 } }, unschedulable: [{ carId: XSS, reason: XSS }] } });
      assert.ok(!html.includes('<img'));
      assert.match(html, /incomplete/);
    });

    /**
     * Drive the live controller through one settings route with a fake API.
     * @param {string} hash
     * @returns {Promise<{details: Array<object>, calls: Array<string>}>}
     */
    async function drive(hash) {
      const shell = loadV6Shell();
      const details = [];
      const calls = [];
      const fakeShell = { setTree() {}, setTelemetry() {}, setTemplates() {}, setAttestation() {}, setDetail(d) { details.push(JSON.parse(JSON.stringify(d))); } };
      const api = async (url) => {
        calls.push(`GET ${url}`);
        if (url === '/api/projects') return { projects: [] };
        if (url === '/api/v6/providers/g2b') return { providers: [], contract: { ok: true } };
        if (url === '/api/v6/medusa-v2/status') return { capability: 'm2', storedMessages: 0, pendingWakes: 0 };
        if (url === '/api/v6/sandboxing/status') return { modes: [], host: { runtimes: {} } };
        return null;
      };
      const apiMutate = async (url, method, body) => {
        calls.push(`${method} ${url} ${JSON.stringify(body).length}`);
        return url === '/api/v6/whatif/simulate' ? { makespan: 8, complete: true, criticalPath: { carIds: ['schema'] }, bottlenecks: {}, unschedulable: [] } : null;
      };
      const controller = shell.tcV6CreateLiveController({ getShell: () => fakeShell, api, apiMutate });
      await controller.handleRoute(shell.tcV6ParseRoute(hash));
      return { details, calls };
    }

    it('#/settings/platform loads the three v6.2 status routes', async () => {
      const { details, calls } = await drive('#/settings/platform');
      for (const u of ['/api/v6/providers/g2b', '/api/v6/medusa-v2/status', '/api/v6/sandboxing/status']) assert.ok(calls.includes(`GET ${u}`), u);
      assert.equal(details[details.length - 1].kind, 'platform');
    });

    it('#/settings/whatif runs the sample scenario through POST /api/v6/whatif/simulate', async () => {
      const { details, calls } = await drive('#/settings/whatif');
      assert.ok(calls.some((c) => c.startsWith('POST /api/v6/whatif/simulate')));
      assert.equal(details[details.length - 1].kind, 'whatif');
      assert.equal(details[details.length - 1].view.result.makespan, 8);
    });
  });
});
