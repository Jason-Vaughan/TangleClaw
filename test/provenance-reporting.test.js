'use strict';

/*
 * The read-only side of the provenance setting (ADR 0019): what the settings
 * modal is handed, and what `tc capabilities` reports. Neither writes a file,
 * and neither may name a path — surfaces are reported by id.
 *
 * The surface report answers with the writer's own gates: the prime and
 * re-entry files exist only while silent prime is on, and a whole-file carrier
 * carries the line only while git ignores it.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync } = require('node:child_process');
const { setLevel } = require('../lib/logger');
setLevel('error');
const store = require('../lib/store');
const engines = require('../lib/engines');
const provenance = require('../lib/provenance');
const sessionOwnership = require('../lib/session-ownership');

/**
 * A defaults-merged project config with the given overrides.
 * @param {object} extra
 * @returns {object}
 */
function config(extra) {
  return { ...JSON.parse(JSON.stringify(store.DEFAULT_PROJECT_CONFIG)), ...extra };
}

/**
 * GET a path from the test server as JSON.
 * @param {import('node:http').Server} server
 * @param {string} urlPath
 * @returns {Promise<{status: number, data: object|null}>}
 */
function get(server, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: urlPath, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        let data = null;
        try { data = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { data = null; }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('provenance reporting', () => {
  let tmpDir;
  let projectsDir;
  let seq = 0;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-prov-reporting-'));
    store._setBasePath(path.join(tmpDir, 'tangleclaw'));
    store.init();
    projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    const cfg = store.config.load();
    cfg.projectsDir = projectsDir;
    store.config.save(cfg);
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * A git repository, optionally ignoring the engine-private carriers.
   * @param {boolean} ignoreCarriers
   * @returns {string} The directory.
   */
  function makeRepo(ignoreCarriers) {
    const dir = path.join(projectsDir, `repo-${++seq}`);
    fs.mkdirSync(dir, { recursive: true });
    execFileSync('git', ['-C', dir, 'init', '-q']);
    if (ignoreCarriers) fs.writeFileSync(path.join(dir, '.gitignore'), '.codex.yaml\n.aider.conf.yml\n');
    return dir;
  }

  describe('engines.provenanceSurfaces', () => {
    it('lists the prime, re-entry and advisory on an engine delivering the hidden prime', () => {
      const r = engines.provenanceSurfaces(makeRepo(true), config({ silentPrime: true }), 'claude', store.engines.get('claude'));
      assert.deepEqual(r.stamped.sort(), ['session-prime', 'session-reentry', 'ui-wrap-advisory']);
      assert.deepEqual(r.unstamped, []);
      assert.equal(r.enabled, false, 'reports the setting as stored: off by default');
    });

    it('names silent prime as the reason when the operator turned it off', () => {
      const r = engines.provenanceSurfaces(makeRepo(true), config({ silentPrime: false }), 'claude', store.engines.get('claude'));
      assert.deepEqual(r.stamped, ['ui-wrap-advisory']);
      assert.deepEqual(r.unstamped.map((u) => u.surfaceId).sort(), ['session-prime', 'session-reentry']);
      for (const u of r.unstamped) assert.equal(u.reason, 'silent prime is off');
    });

    for (const [engineId, surfaceId] of [['codex', 'codex-config'], ['aider', 'aider-config']]) {
      it(`stamps ${surfaceId} while git ignores it`, () => {
        const r = engines.provenanceSurfaces(makeRepo(true), config({}), engineId, store.engines.get(engineId));
        assert.ok(r.stamped.includes(surfaceId));
        assert.ok(r.stamped.includes('ui-wrap-advisory'));
        assert.ok(r.unstamped.every((u) => u.reason === 'this engine delivers no hidden prime'),
          'the prime surfaces are named with the engine as the reason');
      });

      it(`reports ${surfaceId} as unstamped when git does not ignore it`, () => {
        const r = engines.provenanceSurfaces(makeRepo(false), config({}), engineId, store.engines.get(engineId));
        assert.ok(!r.stamped.includes(surfaceId));
        const entry = r.unstamped.find((u) => u.surfaceId === surfaceId);
        assert.ok(entry, `${surfaceId} is reported, not left out`);
        assert.match(entry.reason, /git does not ignore it/);
      });
    }

    it('lists no carrier for an engine with no config file, or one it has not classified', () => {
      const r = engines.provenanceSurfaces(makeRepo(true), config({}), 'claude', store.engines.get('claude'));
      assert.ok(!r.stamped.some((id) => id.endsWith('-config')));
      assert.ok(!r.unstamped.some((u) => u.surfaceId.endsWith('-config')));
      const noFile = engines.provenanceSurfaces(makeRepo(true), config({}), 'openclaw', store.engines.get('openclaw'));
      assert.deepEqual([...noFile.stamped, ...noFile.unstamped.map((u) => u.surfaceId)].sort(),
        ['session-prime', 'session-reentry', 'ui-wrap-advisory']);
    });

    it('reports the setting enabled once the operator turns it on', () => {
      const r = engines.provenanceSurfaces(makeRepo(true), config({ provenanceWatermark: { enabled: true, template: null } }),
        'claude', store.engines.get('claude'));
      assert.equal(r.enabled, true);
    });

    it('reports surfaces as registry ids, never paths', () => {
      const r = engines.provenanceSurfaces(makeRepo(true), config({}), 'codex', store.engines.get('codex'));
      for (const id of [...r.stamped, ...r.unstamped.map((u) => u.surfaceId)]) {
        assert.ok(Object.prototype.hasOwnProperty.call(provenance.REGISTRY, id), `${id} is a registry id`);
      }
    });
  });

  describe('the settings modal is handed the stored setting', () => {
    let projects;
    before(() => { projects = require('../lib/projects'); });

    /**
     * A registered claude project with a stored provenance value.
     * @param {unknown} stored
     * @returns {string} The project name.
     */
    function makeProject(stored) {
      const name = `prov-report-${++seq}`;
      const dir = path.join(projectsDir, name);
      fs.mkdirSync(dir, { recursive: true });
      store.projects.create({ name, path: dir, engine: 'claude' });
      store.projectConfig.save(dir, config({ engine: 'claude', provenanceWatermark: stored }));
      return name;
    }

    it('off with the default template when nothing is stored', async () => {
      const r = await projects.updateProject(makeProject(null), { tags: ['a'] });
      assert.deepEqual(r.project.provenanceWatermark,
        { enabled: false, template: null, defaultTemplate: provenance.DEFAULT_TEMPLATE, warning: null });
    });

    it('the stored override, trimmed, when one is set', async () => {
      const r = await projects.updateProject(makeProject({ enabled: true, template: '  Made by {engine}  ' }), { tags: ['a'] });
      assert.equal(r.project.provenanceWatermark.enabled, true);
      assert.equal(r.project.provenanceWatermark.template, 'Made by {engine}');
      assert.equal(r.project.provenanceWatermark.warning, null);
    });

    it('a hand-edited invalid template as stored, with the warning that the default renders', async () => {
      const r = await projects.updateProject(makeProject({ enabled: true, template: 'bad {nope}' }), { tags: ['a'] });
      assert.equal(r.project.provenanceWatermark.template, 'bad {nope}', 'shown so the operator can fix it');
      assert.match(r.project.provenanceWatermark.warning, /using the default/);
    });
  });

  describe('tc capabilities', () => {
    let server;
    let realExec;
    let realHostname;

    before(async () => {
      realExec = sessionOwnership._internal.execSync;
      realHostname = sessionOwnership._internal.hostname;
      sessionOwnership._internal.execSync = () => { throw new Error('no tailscale'); };
      sessionOwnership._internal.hostname = () => 'prov-host';
      sessionOwnership._resetHostCacheForTest();
      const { createServer } = require('../server');
      server = createServer();
      await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    });

    after(async () => {
      await new Promise((resolve) => server.close(resolve));
      sessionOwnership._internal.execSync = realExec;
      sessionOwnership._internal.hostname = realHostname;
      sessionOwnership._resetHostCacheForTest();
    });

    /**
     * A registered project on `engineId` with a stored provenance value.
     * @param {string} engineId
     * @param {unknown} stored
     * @returns {{id: number, dir: string}}
     */
    function register(engineId, stored) {
      const dir = makeRepo(true);
      const row = store.projects.create({ name: `prov-cap-${++seq}`, path: dir, engine: engineId });
      store.projectConfig.save(dir, config({ engine: engineId, provenanceWatermark: stored }));
      return { id: row.id, dir };
    }

    /**
     * @param {number|undefined} projectId
     * @returns {Promise<object>} The provenance-watermark capability row.
     */
    async function capability(projectId) {
      const r = await get(server, projectId === undefined ? '/api/tc/whoami' : `/api/tc/whoami?projectId=${projectId}`);
      assert.equal(r.status, 200);
      const cap = r.data.capabilities.find((c) => c.id === 'provenance-watermark');
      assert.ok(cap, 'reported, never omitted');
      return cap;
    }

    it('reports off, with what turning it on would stamp', async () => {
      const cap = await capability(register('codex', null).id);
      assert.equal(cap.enabled, false);
      assert.match(cap.detail, /^off for this project/);
      assert.match(cap.detail, /codex-config/);
    });

    it('reports on, with the surfaces that carry it and the ones that do not', async () => {
      const cap = await capability(register('claude', { enabled: true, template: null }).id);
      assert.equal(cap.enabled, true);
      assert.match(cap.detail, /session-prime/);
      assert.match(cap.detail, /ui-wrap-advisory/);
      assert.match(cap.detail, /Project Settings/, 'names where the operator changes it');
    });

    it('names no path and no mutation route', async () => {
      const { id, dir } = register('codex', { enabled: true, template: null });
      const cap = await capability(id);
      assert.ok(!cap.detail.includes(dir), 'no project path');
      assert.ok(!cap.detail.includes('.codex.yaml'), 'no carrier filename');
      assert.ok(!/PATCH|\/api\//.test(cap.detail), 'no route to change the setting');
    });

    it('reports unavailable, not absent, when no project resolved', async () => {
      const cap = await capability(undefined);
      assert.equal(cap.enabled, false);
      assert.match(cap.detail, /unavailable/);
    });
  });
});
