'use strict';

// v6.2.1 (#3038, Car V621-W1-A): Stage 3-4 fleet, wave and report
// end-to-end qualification. Adapted from the Builders-A-D Stage 3-4
// prototype (`v6-stage3-4-fleet-wave-and-report-e2e-suite.md`), which drove
// its own in-memory app; every journey here runs against the LIVE
// v6.0-v6.2 code: the real request handler over a real node:sqlite store,
// and, where a journey has a UI, the real public/v6-shell.js rendering what
// that handler returned.

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

/** A report with all 12 canonical sections, each citing a PR and a Kaizen item. */
const REPORT_HTML = (() => {
  let html = '<html><body>';
  for (const id of ['overview', 'architecture', 'velocity', 'deliverables', 'telemetry', 'postmortem',
    'waves', 'next-sprint', 'plain-english', 'retro', 'longitudinal', 'governance']) {
    html += `<section id="${id}">Narrative for ${id}: the wave scheduler shipped in PR #3016 after KR-01.</section>`;
  }
  return `${html}</body></html>`;
})();

describe('v6 Stage 3-4 E2E: fleet, wave and report, against the live server (#3038)', () => {
  let tempDir;
  let prevBase;

  before(() => {
    prevBase = store._getBasePath();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v6-e2e-fleet-'));
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
  const post = (url, body, opts) => send('POST', url, Object.assign({ body: body || {} }, opts));
  const get = (url, opts) => send('GET', url, opts);
  const json = (res) => JSON.parse(res.body);

  /**
   * @param {string} name
   * @returns {number}
   */
  function seedProject(name) {
    return store.getDb().prepare('INSERT INTO projects (name, path, archived) VALUES (?, ?, 0)').run(name, path.join(tempDir, name)).lastInsertRowid;
  }

  describe('C2/C1: fleet templates and fleets', () => {
    it('the shell plans a fleet template through the live API and renders the plan', async () => {
      const G = loadV6Shell();
      const { doc } = makeDocument([]);
      const root = doc.createElement('div');
      withIdParsingInnerHTML(root, doc);
      doc.body.appendChild(root);
      let shell = null;
      const apiMutate = async (url, method, body) => {
        const res = await send(method, url, { body: body || {} });
        return res.statusCode >= 200 && res.statusCode < 300 ? json(res) : null;
      };
      const live = G.tcV6CreateLiveController({ getShell: () => shell, api: async () => null, apiMutate });
      shell = G.tcCreateV6Shell(doc, { root, window: { location: { hash: '#/settings/' }, addEventListener() {}, removeEventListener() {} } });
      await live.launchTemplate('small-4-seat');
      assert.match(root.innerHTML, /Plan preview — small-4-seat/);
      assert.match(root.innerHTML, /PM/);
    });

    it('lists the three versioned templates and refuses an unknown one', async () => {
      const list = json(await get('/api/v6/fleet-templates'));
      assert.deepEqual(list.templates.map((t) => t.id).sort(), ['large-configurable', 'recommended-10-role', 'small-4-seat']);
      assert.ok((await post('/api/v6/fleet-templates/no-such/plan', {})).statusCode >= 400);
    });

    it('creates a fleet under a real project\'s logical project and walks it to active with revision CAS', async () => {
      const projectId = seedProject('e2e-fleet');
      const lp = `lp-${projectId}`;
      const created = await post('/api/v6/fleets', { logicalProjectId: lp, displayName: 'E2E Fleet', templateId: 'small-4-seat', templateVersion: 1 });
      assert.equal(created.statusCode, 201, created.body);
      const fleetId = json(created).id;
      const fetched = json(await get(`/api/v6/fleets/${fleetId}`));
      assert.equal(fetched.state || fetched.fleet?.state, 'draft');
      const activate = await send('PATCH', `/api/v6/fleets/${fleetId}/state`, { body: { logicalProjectId: lp, nextState: 'active', expectedPolicyRevision: 1 } });
      assert.equal(activate.statusCode, 200, activate.body);
      const stale = await send('PATCH', `/api/v6/fleets/${fleetId}/state`, { body: { logicalProjectId: lp, nextState: 'paused', expectedPolicyRevision: 1 } });
      assert.equal(stale.statusCode, 409, `a stale policy revision must conflict: ${stale.body}`);
      assert.match((await get(`/api/v6/logical-projects/${lp}/hierarchy`)).body, /E2E Fleet/);
    });

    it('refuses a non-operator fleet write', async () => {
      const res = await post('/api/v6/fleets', { logicalProjectId: 'lp-1', displayName: 'x' }, { operator: false });
      assert.ok([401, 403].includes(res.statusCode), res.body);
    });
  });

  describe('C3/E3b: wave runs and what-if simulation', () => {
    const cars = [
      { id: 'schema', fileScope: ['lib/store.js'] },
      { id: 'api', dependsOn: ['schema'], fileScope: ['server.js'] },
      { id: 'ui', dependsOn: ['api'], fileScope: ['public/app.js'] }
    ];

    it('plans dependency waves, creates a run bound to its project, and keeps it out of other projects', async () => {
      const waves = json(await post('/api/v6/wave-scheduler/topological-waves', { cars })).waves;
      assert.equal(waves.length, 3, 'a three-car chain is three waves');
      const projectId = seedProject('e2e-wave');
      const other = seedProject('e2e-wave-other');
      const created = await post(`/api/v6/projects/${projectId}/wave-runs`, { id: 'run-e2e', fleetId: 'fleet-e2e', cars });
      assert.equal(created.statusCode, 201, created.body);
      assert.equal(json(await get(`/api/v6/projects/${projectId}/wave-runs/run-e2e`)).id, 'run-e2e');
      assert.equal((await get(`/api/v6/projects/${other}/wave-runs/run-e2e`)).statusCode, 404);
      const again = await post(`/api/v6/projects/${projectId}/wave-runs`, { id: 'run-e2e', fleetId: 'fleet-e2e', cars });
      assert.ok(again.statusCode >= 400, 'a run id is created once');
    });

    it('simulates the same chain, then shows a second lane shortening it in a comparison', async () => {
      const scenario = {
        trains: [{ id: 't', cars: [{ id: 'schema', effort: 3, files: ['lib/store.js'] }, { id: 'docs', effort: 3, files: ['README.md'] },
          { id: 'api', effort: 2, dependsOn: ['schema'], files: ['server.js'] }] }],
        rolePools: { Builder: 1 }
      };
      const base = json(await post('/api/v6/whatif/simulate', { scenario }));
      assert.equal(base.makespan, 8);
      const cmp = json(await post('/api/v6/whatif/compare', { baseline: scenario, variants: [{ name: 'two-lanes', scenario: { ...scenario, rolePools: { Builder: 2 } } }] }));
      assert.deepEqual([cmp.variants[0].makespan, cmp.variants[0].makespanDelta], [5, -3]);
    });
  });

  describe('E4/E6a/E6b: report presentation, search and grounded ask', () => {
    it('presents a 12-section report in 3 pillars, prints it, and serves the popover catalog', async () => {
      const view = json(await post('/api/v6/reports/present', { html: REPORT_HTML }));
      assert.equal(view.sections.length, 12);
      assert.equal(Object.keys(view.pillars).length, 3);
      assert.match(json(await post('/api/v6/reports/print-view', { html: REPORT_HTML })).html, /data-e4-print/);
      assert.equal(Object.keys(json(await get('/api/v6/reports/popovers')).popovers).length, 12);
    });

    it('indexes, cites and answers a question from a report whose index fits the route body limit', async () => {
      const SMALL = '<html><body><section id="overview">The wave scheduler shipped in PR #3016 after KR-01.</section>'
        + '<section id="architecture">Notes.</section><section id="velocity">Notes.</section><section id="deliverables">Notes.</section></body></html>';
      const index = json(await post('/api/v6/reports/search-index', { html: SMALL, version: 'v6.2.1' }));
      const citeRes = await post('/api/v6/reports/cite', { index, query: '3016' });
      assert.equal(citeRes.statusCode, 200, citeRes.body);
      assert.ok(json(citeRes).results.some((r) => r.type === 'pr' && r.badge === '[PR #3016]'));
      const answer = json(await post('/api/v6/reports/ask', { reports: [{ version: 'v6.2.1', index }], question: 'When did the wave scheduler ship?' }));
      assert.equal(answer.ok, true);
      assert.equal(answer.mode, 'deterministic', 'no model adapter is wired, so the answer is never labelled synthesized');
      assert.ok(answer.citations.length > 0, 'every answer carries its citations');
    });

    it('a full 12-section report index is cited over HTTP (#3041)', async () => {
      const index = json(await post('/api/v6/reports/search-index', { html: REPORT_HTML, version: 'v6.2.1' }));
      assert.equal(index.sections.length, 12);
      assert.ok(Buffer.byteLength(JSON.stringify({ index, query: '3016' })) > 10 * 1024, 'the fixture exceeds the old 10 KB default');
      const res = await post('/api/v6/reports/cite', { index, query: '3016' });
      assert.equal(res.statusCode, 200, res.body.slice(0, 200));
      assert.ok(json(res).results.some((r) => r.type === 'pr' && r.badge === '[PR #3016]'));
    });

    it('a report the size of a real published one survives present, index, cite and a multi-report ask (#3041)', async () => {
      // ~200 KB of HTML (the largest published v6 report is 187 KB), mostly
      // prose with one PR and one Kaizen reference per section.
      let html = '<html><body>';
      for (const id of ['overview', 'architecture', 'velocity', 'deliverables', 'telemetry', 'postmortem',
        'waves', 'next-sprint', 'plain-english', 'retro', 'longitudinal', 'governance']) {
        html += `<section id="${id}"><p>The ${id} work shipped in PR #3016 after KR-01.</p>${
          `<p>Plain narrative prose about the ${id} section that explains what happened and why it mattered to the release.</p>`.repeat(140)}</section>`;
      }
      html += '</body></html>';
      assert.ok(Buffer.byteLength(html) > 180 * 1024, `fixture is ${Buffer.byteLength(html)} bytes`);
      assert.equal((await post('/api/v6/reports/present', { html })).statusCode, 200);
      const indexRes = await post('/api/v6/reports/search-index', { html, version: 'v6.2.1' });
      assert.equal(indexRes.statusCode, 200);
      const index = json(indexRes);
      assert.equal((await post('/api/v6/reports/cite', { index, query: '3016' })).statusCode, 200);
      const ask = await post('/api/v6/reports/ask', { reports: [{ version: 'v6.2.0', index }, { version: 'v6.2.1', index }], question: 'What shipped in PR 3016?' });
      assert.equal(ask.statusCode, 200, ask.body.slice(0, 200));
      assert.equal(json(ask).ok, true);
    });

    it('the report routes still refuse a body over their own limit', async () => {
      const huge = `<html><body><section id="overview">${'x'.repeat(1024 * 1024 + 1)}</section></body></html>`;
      assert.equal((await post('/api/v6/reports/present', { html: huge })).statusCode, 413);
    });

    it('refuses malformed report input rather than guessing', async () => {
      assert.equal((await post('/api/v6/reports/present', {})).statusCode, 400);
      assert.ok((await post('/api/v6/reports/ask', { reports: 'nope', question: 'x' })).statusCode >= 400);
    });
  });
});
