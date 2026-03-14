'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const store = require('../lib/store');
const { createServer } = require('../server');

let tmpDir;
let server;
let port;

/**
 * Make an HTTP request to the test server.
 * @param {string} method - HTTP method
 * @param {string} urlPath - URL path
 * @param {object} [body] - Request body
 * @returns {Promise<{ status: number, data: object }>}
 */
function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: '127.0.0.1',
      port,
      path: urlPath,
      method,
      headers: { 'Content-Type': 'application/json' }
    };

    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let data;
        try {
          data = JSON.parse(raw);
        } catch {
          data = raw;
        }
        resolve({ status: res.statusCode, data });
      });
    });

    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

before(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-meth-'));
  store._setBasePath(tmpDir);
  store.init();

  server = createServer();
  await new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      port = server.address().port;
      resolve();
    });
  });
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('GET /api/methodologies', () => {
  it('returns list of methodology templates', async () => {
    const { status, data } = await request('GET', '/api/methodologies');
    assert.equal(status, 200);
    assert.ok(Array.isArray(data.methodologies));
    assert.ok(data.methodologies.length >= 3);

    // Check shape of each template
    for (const m of data.methodologies) {
      assert.ok(m.id, 'id is required');
      assert.ok(m.name, 'name is required');
      assert.ok(typeof m.description === 'string', 'description is required');
      assert.ok(Array.isArray(m.phases), 'phases must be an array');
      assert.ok(typeof m.defaultRules === 'object', 'defaultRules must be an object');
    }
  });

  it('includes prawduct with expected phases', async () => {
    const { data } = await request('GET', '/api/methodologies');
    const prawduct = data.methodologies.find((m) => m.id === 'prawduct');
    assert.ok(prawduct);
    assert.deepEqual(prawduct.phases, ['discovery', 'planning', 'building']);
    assert.equal(prawduct.defaultRules.independentCritic, true);
    assert.equal(prawduct.defaultRules.docsParity, true);
  });

  it('includes tilt with identity sentry default', async () => {
    const { data } = await request('GET', '/api/methodologies');
    const tilt = data.methodologies.find((m) => m.id === 'tilt');
    assert.ok(tilt);
    assert.deepEqual(tilt.phases, ['setup', 'development', 'review']);
    assert.equal(tilt.defaultRules.identitySentry, true);
  });

  it('includes minimal with empty phases and rules', async () => {
    const { data } = await request('GET', '/api/methodologies');
    const minimal = data.methodologies.find((m) => m.id === 'minimal');
    assert.ok(minimal);
    assert.deepEqual(minimal.phases, []);
    assert.deepEqual(minimal.defaultRules, {});
  });
});

describe('GET /api/methodologies/:id', () => {
  it('returns full template for prawduct', async () => {
    const { status, data } = await request('GET', '/api/methodologies/prawduct');
    assert.equal(status, 200);
    assert.equal(data.id, 'prawduct');
    assert.equal(data.name, 'Prawduct');
    assert.ok(Array.isArray(data.phases));
    assert.equal(data.phases.length, 3);
    assert.ok(data.statusContract);
    assert.ok(data.detection);
    assert.ok(data.wrap);
    assert.ok(data.prime);
    assert.ok(data.init);
    assert.ok(data.defaultRules);
  });

  it('returns full template for tilt', async () => {
    const { status, data } = await request('GET', '/api/methodologies/tilt');
    assert.equal(status, 200);
    assert.equal(data.id, 'tilt');
    assert.ok(data.phases.length === 3);
    assert.equal(data.detection.strategy, 'directory');
    assert.equal(data.detection.target, '.tilt');
  });

  it('returns full template for minimal', async () => {
    const { status, data } = await request('GET', '/api/methodologies/minimal');
    assert.equal(status, 200);
    assert.equal(data.id, 'minimal');
    assert.deepEqual(data.phases, []);
  });

  it('returns 404 for unknown methodology', async () => {
    const { status, data } = await request('GET', '/api/methodologies/nonexistent');
    assert.equal(status, 404);
    assert.equal(data.code, 'NOT_FOUND');
    assert.ok(data.error.includes('nonexistent'));
  });

  it('returns phase details with all fields', async () => {
    const { data } = await request('GET', '/api/methodologies/prawduct');
    const discovery = data.phases[0];
    assert.equal(discovery.id, 'discovery');
    assert.equal(discovery.name, 'Discovery');
    assert.equal(discovery.weight, 'deep');
    assert.equal(discovery.offerContextReset, false);

    const planning = data.phases[1];
    assert.equal(planning.offerContextReset, true);
  });

  it('returns statusContract details', async () => {
    const { data } = await request('GET', '/api/methodologies/prawduct');
    const sc = data.statusContract;
    assert.ok(sc.command);
    assert.equal(sc.parse, 'yaml-field');
    assert.equal(sc.field, 'work_in_progress.description');
    assert.equal(sc.badge, 'phase');
    assert.ok(sc.colorMap);
  });
});
