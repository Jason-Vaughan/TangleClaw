'use strict';

// #2883: GET /api/scorecard, the thin read-only route over
// lib/scorecard-cache.js#readScorecardCache. Same real-server fixture
// shape test/api-plan-docs.test.js's own scorecard test uses, including
// its fixtures/scorecard-v1.json document.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const scorecardCache = require('../lib/scorecard-cache');
const { createServer } = require('../server');

function get(server, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path: urlPath, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        let data = null;
        try { data = JSON.parse(body); } catch { data = null; }
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('GET /api/scorecard (#2883)', () => {
  let tmpDir;
  let server;
  let cacheFile;

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-scorecard-'));
    store._setBasePath(tmpDir);
    store.init();
    cacheFile = scorecardCache.cachePath(store._getBasePath());

    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('answers status: missing with no scorecard ever published to this host', async () => {
    const r = await get(server, '/api/scorecard');
    assert.equal(r.status, 200);
    assert.equal(r.data.status, 'missing');
    assert.match(r.data.reason, /no scorecard has been published/);
  });

  it('answers status: ok with the fresh cached document once one is written', async () => {
    const doc = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'scorecard-v1.json'), 'utf8'));
    doc.generatedAt = Date.now() - 1000;
    doc.freshUntil = Date.now() + 3600000;
    scorecardCache.writeScorecardCache(cacheFile, doc);

    const r = await get(server, '/api/scorecard');
    assert.equal(r.status, 200);
    assert.equal(r.data.status, 'ok');
    assert.equal(r.data.doc.schema, doc.schema);
    assert.equal(r.data.doc.generatedAt, doc.generatedAt);
  });

  it('answers status: stale once the document is past its freshUntil, figures still included', async () => {
    const doc = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'scorecard-v1.json'), 'utf8'));
    doc.generatedAt = Date.now() - 10000;
    doc.freshUntil = Date.now() - 1000;
    scorecardCache.writeScorecardCache(cacheFile, doc);

    const r = await get(server, '/api/scorecard');
    assert.equal(r.status, 200);
    assert.equal(r.data.status, 'stale');
    assert.ok(r.data.doc, 'the stale document\'s own figures are still returned, not withheld');
  });
});
